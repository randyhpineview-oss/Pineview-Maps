"""FastAPI routes for the lone-worker check-in feature.

Three routers, audience-separated:

  * ``me_router``    — worker self-service. Any signed-in user can:
      - GET    /api/checkins/me/today
      - POST   /api/shifts/start
      - POST   /api/shifts/{id}/end
      - PATCH  /api/shifts/{id}/composition
      - POST   /api/checkins
      - GET    /api/checkins/me/preferences
      - PUT    /api/checkins/me/preferences
      - GET    /api/push/vapid-public-key
      - POST   /api/push/subscribe
      - DELETE /api/push/subscribe
      - GET    /api/checkins/me/assignable-users

  * ``admin_router`` — admin / office only:
      - GET    /api/admin/checkin-overview
      - GET    /api/admin/shifts/active
      - GET    /api/admin/shifts
      - POST   /api/admin/shifts/{id}/end
      - POST   /api/admin/shifts/{id}/checkin
      - GET    /api/admin/checkin-recipients
      - POST   /api/admin/checkin-recipients
      - PUT    /api/admin/checkin-recipients/{id}
      - DELETE /api/admin/checkin-recipients/{id}
      - POST   /api/admin/checkin-recipients/primary

  * ``cron_router``  — bearer secret (CHECKIN_SCAN_SECRET):
      - POST   /api/checkins/scan

The lazy auto-end resolver (``_resolve_shift_state``) is invoked on every
read of an active shift so we never serve stale "still on shift" data for
a shift that should have ended at midnight or after 14 h idle.
"""
from __future__ import annotations

import asyncio
from datetime import date, datetime, timedelta, timezone
from typing import Optional
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Body, Depends, Header, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, EmailStr, Field
from sqlalchemy import and_, cast, or_, select
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Session

from app.auth import get_current_user, require_roles
from app.checkin_cadence import (
    OFFICE_REPEAT_AFTER_URGENT_MIN,
    OFFICE_ALERTS,
    STALE_END_HOURS,
    WORKER_ALERTS,
    WORKER_REPEAT_INTERVAL_MIN,
    compute_next_deadline,
    deadline_for_mode_change,
    office_repeat_kinds,
    overdue_repeat_kinds,
    should_auto_end,
    tier as compute_tier,
)
from app.checkin_models import (
    Checkin,
    CheckinAlert,
    OfficeAlertRecipient,
    PushSubscription,
    Shift,
    ShiftChange,
    UserProfile,
)
from app.config import get_settings
from app.database import get_db
from app.device_models import Device
from app.email_service import (
    send_checkin_reminder_email,
    send_office_overdue_email_standard,
    send_office_overdue_email_urgent,
)
from app.log_util import get_logger
from app.models import RoleEnum, User
from app.push_service import PushPayload, push_configured, send_push

settings = get_settings()
logger = get_logger(__name__)
VANCOUVER = ZoneInfo("America/Vancouver")


# Routers --------------------------------------------------------------
me_router = APIRouter(
    tags=["checkins-me"],
    dependencies=[Depends(require_roles(RoleEnum.admin, RoleEnum.office, RoleEnum.worker))],
)
admin_router = APIRouter(
    tags=["checkins-admin"],
    dependencies=[Depends(require_roles(RoleEnum.admin, RoleEnum.office))],
)
cron_router = APIRouter(tags=["checkins-cron"])


# ──────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────


def _now() -> datetime:
    """UTC-aware now. Single chokepoint so tests can monkeypatch."""
    return datetime.now(timezone.utc)


def _aware(dt: Optional[datetime]) -> Optional[datetime]:
    """Coerce a naive (SQLite) datetime to UTC-aware; pass through aware."""
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def _resolve_shift_state(db: Session, shift: Shift) -> Shift:
    """Lazy auto-end: persist ended_at + auto_end_reason if the shift
    should have ended already (local midnight passed, or no check-in for
    14 h). Returns the (possibly updated) shift.

    Called on every read of an active shift so the API never serves stale
    "still on shift" state. Idempotent on already-ended shifts.
    """
    reason = should_auto_end(shift, now=_now())
    if reason is None:
        return shift
    shift.ended_at = _now()
    shift.auto_end_reason = reason
    db.commit()
    db.refresh(shift)
    return shift


def _get_active_shift(db: Session, user_id: int) -> Optional[Shift]:
    """Return the user's currently-active LEAD shift (after lazy auto-end
    check), or None if they're not the lead on any active shift.

    Only matches shifts where the user is the lead (``shift.user_id ==
    user_id``). For the "am I on shift today as a lead OR as a crew
    teammate" question, use :func:`_get_user_today_shift` instead.
    """
    rows = (
        db.query(Shift)
        .filter(Shift.user_id == user_id, Shift.ended_at.is_(None))
        .order_by(Shift.started_at.desc())
        .all()
    )
    for row in rows:
        resolved = _resolve_shift_state(db, row)
        if resolved.ended_at is None:
            return resolved
    return None


def _get_user_today_shift(db: Session, user_id: int) -> Optional[Shift]:
    """Return the active shift this user is participating in today.

    Matches either:
      * the user is the lead (``shift.user_id == user_id``), or
      * the user is in the lead's ``crew_user_ids`` JSON list.

    Crew teammates and the lead share equal ownership: any of them can
    check in, end the shift, edit composition, or be the target of push
    alerts. This is the core helper that makes "I told Mark to check in
    for me, and Mark's tap counted as our crew check-in" work.

    Crew match: Postgres supports the ``@>`` JSONB containment operator
    for an efficient indexed query; SQLite (used by tests) doesn't, so
    we fall back to scanning active shifts in Python. Either way the
    output is the single Shift the user is currently on, or None.
    """
    # First the cheap path: are they the lead on an active shift?
    own = _get_active_shift(db, user_id)
    if own is not None:
        return own

    # Then the crew-membership path. Try the JSONB-native query first.
    dialect = db.bind.dialect.name if db.bind is not None else ""
    candidates: list[Shift] = []
    if dialect == "postgresql":
        try:
            candidates = (
                db.query(Shift)
                .filter(
                    Shift.ended_at.is_(None),
                    Shift.crew_user_ids.op("@>")(cast([user_id], JSONB)),
                )
                .order_by(Shift.started_at.desc())
                .all()
            )
        except Exception:
            # Fall through to the Python-side scan if the operator
            # blows up (e.g. weird column type from an old migration).
            candidates = []
    if not candidates:
        active = (
            db.query(Shift)
            .filter(Shift.ended_at.is_(None))
            .order_by(Shift.started_at.desc())
            .all()
        )
        candidates = [
            s for s in active
            if user_id in (s.crew_user_ids or [])
        ]

    for row in candidates:
        resolved = _resolve_shift_state(db, row)
        if resolved.ended_at is None:
            return resolved
    return None


def _auto_link_device(db: Session, user_id: int) -> Optional[int]:
    """If the user is assigned to exactly one active device, return its id.
    Else None (admin can wire it up later from the dashboard)."""
    rows = (
        db.query(Device.id)
        .filter(Device.assigned_user_id == user_id, Device.is_active.is_(True))
        .all()
    )
    return rows[0][0] if len(rows) == 1 else None


def _local_day_window(d: Optional[date] = None) -> tuple[datetime, datetime]:
    """Return [start, end) for the given local-Vancouver date (default = today).

    Used by ``/api/checkins/me/today`` so a shift started yesterday but
    still active shows up; and by the History tab's date filter.
    """
    target = d or datetime.now(VANCOUVER).date()
    start_local = datetime.combine(target, datetime.min.time(), tzinfo=VANCOUVER)
    end_local = start_local + timedelta(days=1)
    return start_local.astimezone(timezone.utc), end_local.astimezone(timezone.utc)


def _serialize_shift(
    shift: Shift,
    user: Optional[User] = None,
    users_by_id: Optional[dict[int, User]] = None,
) -> dict:
    """Return the shift as the JSON shape the frontend expects.

    When ``user`` is supplied, ``user_name`` and ``user_email`` are
    embedded so the dashboard doesn't have to do a separate lookup
    (which used to fall back to "User #N" for admins on shift, since
    the crew-candidates endpoint excludes the caller AND filters to
    workers-only).

    When ``users_by_id`` is supplied, every crew member id is resolved
    into a ``{id, name, email}`` object inside ``crew_members``. This
    lets the Overview / Active / History dashboards show each crew
    member by name (the user's "show me who's in this crew" ask)
    without any extra fetch. Missing ids are skipped silently so a
    deleted crew teammate doesn't blow up the response.
    """
    next_deadline = _aware(shift.next_deadline_at)
    now = _now()
    minutes_to = None
    if next_deadline is not None:
        minutes_to = (next_deadline - now).total_seconds() / 60.0
    crew_ids = list(shift.crew_user_ids or [])
    crew_members: list[dict] = []
    if users_by_id is not None:
        for cid in crew_ids:
            cu = users_by_id.get(cid)
            if cu is None:
                continue
            crew_members.append({
                "id": cu.id,
                "name": cu.name,
                "email": cu.email,
            })
    return {
        "id": shift.id,
        "user_id": shift.user_id,
        "user_name": user.name if user is not None else None,
        "user_email": user.email if user is not None else None,
        "device_id": shift.device_id,
        "mode": shift.mode,
        "crew_user_ids": crew_ids,
        "crew_members": crew_members,
        "crew_freeform": shift.crew_freeform or "",
        "started_at": _aware(shift.started_at),
        "ended_at": _aware(shift.ended_at),
        "ended_by_user_id": shift.ended_by_user_id,
        "auto_end_reason": shift.auto_end_reason,
        "last_checkin_at": _aware(shift.last_checkin_at),
        "next_deadline_at": next_deadline,
        "minutes_to_deadline": minutes_to,
        "status_tier": compute_tier(shift, now=now),
        "notes": shift.notes or "",
    }


def _users_by_id(db: Session, user_ids: list[int]) -> dict[int, User]:
    """Batch-fetch users keyed by id. Used by the admin endpoints to
    embed names into shift JSON without N+1 queries.
    """
    ids = [uid for uid in {*user_ids} if uid is not None]
    if not ids:
        return {}
    rows = db.query(User).filter(User.id.in_(ids)).all()
    return {u.id: u for u in rows}


def _serialize_checkin(c: Checkin) -> dict:
    return {
        "id": c.id,
        "shift_id": c.shift_id,
        "user_id": c.user_id,
        "recorded_by_user_id": c.recorded_by_user_id,
        "lat": c.lat,
        "lon": c.lon,
        "accuracy_m": float(c.accuracy_m) if c.accuracy_m is not None else None,
        "notes": c.notes,
        "created_at": _aware(c.created_at),
    }


def _ensure_profile(db: Session, user_id: int) -> UserProfile:
    """Get-or-create the user_profiles row. Idempotent."""
    profile = db.query(UserProfile).filter(UserProfile.user_id == user_id).first()
    if profile is None:
        profile = UserProfile(user_id=user_id)
        db.add(profile)
        db.commit()
        db.refresh(profile)
    return profile


def _resolve_notify_email(db: Session, user: User) -> Optional[str]:
    """Return the address to send check-in emails to, or None if email is disabled.

    Priority: profile.notify_email_address (override) > user.email (auth).
    Returns None when notify_email=False or no email is available.
    """
    profile = db.query(UserProfile).filter(UserProfile.user_id == user.id).first()
    if profile is None or not profile.notify_email:
        return None
    return profile.notify_email_address or user.email


def _fanout_push(
    db: Session,
    *,
    user_id: int,
    title: str,
    body: str,
    urgent: bool = False,
    shift_id: Optional[int] = None,
) -> list[str]:
    """Send a push notification to every active subscription for ``user_id``.

    Returns the list of endpoints attempted (truncated for logging).
    Caller is responsible for the ``checkin_alerts`` ledger.
    """
    if not push_configured():
        return []
    subs = db.query(PushSubscription).filter(PushSubscription.user_id == user_id).all()
    payload = PushPayload(
        title=title,
        body=body,
        tag="checkin",
        urgent=urgent,
        url="/",
        shift_id=shift_id,
    )
    endpoints: list[str] = []
    for sub in subs:
        try:
            send_push(db, sub, payload)
            sub.last_used_at = _now()
            endpoints.append(sub.endpoint)
        except Exception as exc:
            logger.warning("Push fanout to sub %s failed: %s", sub.id, exc)
    db.commit()
    return endpoints


# ──────────────────────────────────────────────────────────────────────
# Pydantic schemas
# ──────────────────────────────────────────────────────────────────────


class CrewMemberRead(BaseModel):
    """One resolved crew teammate, embedded inside ShiftRead.crew_members.

    Lets the dashboard print "Crew: Joe, Mark, Sarah" with mini avatars
    without a second roundtrip to the assignable-users endpoint, and
    survives admins removing the teammate's account later (the shift
    JSON keeps a snapshot of the name at fetch time).
    """
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    email: Optional[str] = None


class ShiftRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    user_id: int
    # Embedded by the admin list endpoints so the dashboard doesn't have to
    # do a separate lookup (the crew-candidates endpoint excludes the
    # caller AND filters to workers, so admin-on-shift used to render as
    # "User #N"). May be None for self-serve worker endpoints that don't
    # bother to resolve them.
    user_name: Optional[str] = None
    user_email: Optional[str] = None
    device_id: Optional[int] = None
    mode: str
    crew_user_ids: list[int] = []
    # Resolved crew teammates (one row per id in crew_user_ids that the
    # server could still find in `users`). Always present on the admin
    # dashboard endpoints; may be empty on the worker self-serve ones
    # because we don't bother to resolve there.
    crew_members: list[CrewMemberRead] = []
    crew_freeform: str = ""
    started_at: datetime
    ended_at: Optional[datetime] = None
    ended_by_user_id: Optional[int] = None
    auto_end_reason: Optional[str] = None
    last_checkin_at: Optional[datetime] = None
    next_deadline_at: datetime
    minutes_to_deadline: Optional[float] = None
    status_tier: Optional[str] = None
    notes: str = ""


class CheckinRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    shift_id: int
    user_id: int
    recorded_by_user_id: Optional[int] = None
    lat: Optional[float] = None
    lon: Optional[float] = None
    accuracy_m: Optional[float] = None
    notes: Optional[str] = None
    created_at: datetime


class TodayResponse(BaseModel):
    shift: Optional[ShiftRead] = None
    checkins: list[CheckinRead] = []


class ShiftStartRequest(BaseModel):
    # 'alone' (2 h), 'crew' (4 h), 'off' (mark today as off — suppresses banner).
    mode: str = Field(..., pattern=r"^(alone|crew|off)$")
    crew_user_ids: list[int] = []
    crew_freeform: str = ""
    notes: str = ""


class ShiftCompositionRequest(BaseModel):
    mode: str = Field(..., pattern=r"^(alone|crew)$")
    crew_user_ids: list[int] = []
    crew_freeform: str = ""


class CheckinCreate(BaseModel):
    # All fields optional — a worker without geolocation permission can
    # still tap "I'm OK" and we record the time only.
    lat: Optional[float] = None
    lon: Optional[float] = None
    accuracy_m: Optional[float] = None
    notes: Optional[str] = None


class PreferencesPayload(BaseModel):
    notify_push: bool = True
    notify_email: bool = False
    notify_email_address: Optional[str] = None
    last_mode: Optional[str] = None
    last_crew_user_ids: Optional[list[int]] = None


class PreferencesRead(BaseModel):
    notify_push: bool
    notify_email: bool
    notify_email_address: Optional[str] = None
    last_mode: Optional[str] = None
    last_crew_user_ids: list[int] = []
    # Convenience: the auth email so the frontend can show "Use my login email"
    auth_email: Optional[str] = None


class PushSubscribePayload(BaseModel):
    endpoint: str
    p256dh: str
    auth: str
    user_agent: Optional[str] = None


class VapidKeyResponse(BaseModel):
    public_key: str


class AssignableUserRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    email: Optional[str] = None
    role: Optional[str] = None


class OverviewEntry(BaseModel):
    user_id: int
    display_name: str
    role: str
    avatar_seed: str
    shift: Optional[ShiftRead] = None
    truck_id: Optional[int] = None
    truck_label: Optional[str] = None
    truck_color: Optional[str] = None
    truck_last_seen_at: Optional[datetime] = None
    truck_lat: Optional[float] = None
    truck_lon: Optional[float] = None
    status_tier: str


class RecipientRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    email: EmailStr
    display_name: Optional[str] = None
    is_active: bool
    is_primary: bool
    created_at: datetime


class RecipientCreate(BaseModel):
    email: EmailStr
    display_name: Optional[str] = None
    is_active: bool = True


class RecipientUpdate(BaseModel):
    email: Optional[EmailStr] = None
    display_name: Optional[str] = None
    is_active: Optional[bool] = None


class RecipientPrimaryUpsert(BaseModel):
    email: EmailStr
    display_name: Optional[str] = None


class ScanResponse(BaseModel):
    scanned: int = 0
    auto_ended: int = 0
    worker_alerts_sent: int = 0
    office_alerts_sent: int = 0
    errors: int = 0


# ──────────────────────────────────────────────────────────────────────
# /api/checkins/me/*   (worker self-service)
# ──────────────────────────────────────────────────────────────────────


@me_router.get("/api/checkins/me/today", response_model=TodayResponse)
def get_today(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> TodayResponse:
    """Return the user's current shift (if any) + today's check-ins.

    Used by ``MyCheckInsOverlay`` on mount. The shift is auto-ended
    lazily on read if midnight passed or stale 14 h.
    """
    shift = _get_user_today_shift(db, current_user.id)
    start, end = _local_day_window()
    # Checkins: show ALL check-ins on this shared shift so any crew
    # member can see the team's history, not just their own taps.
    if shift:
        checkins_q = (
            db.query(Checkin)
            .filter(
                Checkin.shift_id == shift.id,
                Checkin.created_at >= start,
                Checkin.created_at < end,
            )
            .order_by(Checkin.created_at.desc())
            .all()
        )
    else:
        checkins_q = []
    return TodayResponse(
        shift=ShiftRead(**_serialize_shift(shift)) if shift else None,
        checkins=[CheckinRead(**_serialize_checkin(c)) for c in checkins_q],
    )


@me_router.post("/api/shifts/start", response_model=ShiftRead)
def start_shift(
    payload: ShiftStartRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ShiftRead:
    """Create a new shift. Errors if the user already has one active.

    Auto-links to whichever device has assigned_user_id = current user
    AND is_active, if exactly one match. Stores the choice in
    user_profiles.last_mode / last_crew_user_ids for next-time defaults.
    """
    # A user can start their own shift UNLESS they are already on
    # someone else's crew (shared ownership). We block that because
    # being in two active crews at once is ambiguous for alerts.
    existing_as_crew = _get_user_today_shift(db, current_user.id)
    if existing_as_crew is not None:
        if existing_as_crew.user_id == current_user.id:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="You already have an active shift. End it before starting a new one.",
            )
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="You are already part of an active crew. Leave that crew before starting your own shift.",
        )
    now = _now()
    next_deadline = compute_next_deadline(mode=payload.mode, started_at=now)
    shift = Shift(
        user_id=current_user.id,
        device_id=_auto_link_device(db, current_user.id),
        mode=payload.mode,
        crew_user_ids=list(dict.fromkeys(payload.crew_user_ids or [])),
        crew_freeform=payload.crew_freeform or "",
        started_at=now,
        next_deadline_at=next_deadline,
        notes=payload.notes or "",
    )
    db.add(shift)
    db.commit()
    db.refresh(shift)

    # Update last-used defaults for next time.
    profile = _ensure_profile(db, current_user.id)
    profile.last_mode = payload.mode if payload.mode != "off" else profile.last_mode
    if payload.mode == "crew":
        profile.last_crew_user_ids = list(dict.fromkeys(payload.crew_user_ids or []))
    db.commit()

    return ShiftRead(**_serialize_shift(shift))


@me_router.post("/api/shifts/{shift_id}/end", response_model=ShiftRead)
def end_shift(
    shift_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ShiftRead:
    """End your own shift. 403 if you try to end someone else's.

    Idempotent: ending an already-ended shift returns it without
    error so a double-tap from a flaky network doesn't blow up.
    """
    shift = db.query(Shift).filter(Shift.id == shift_id).first()
    if shift is None:
        raise HTTPException(status_code=404, detail="Shift not found")
    # Shared ownership: any crew member can end the shift, not just the
    # lead. Admins/office can also end anyone's shift.
    crew_ids = set(shift.crew_user_ids or [])
    if (
        shift.user_id != current_user.id
        and current_user.id not in crew_ids
        and current_user.role not in (RoleEnum.admin, RoleEnum.office)
    ):
        raise HTTPException(status_code=403, detail="Not your shift")
    if shift.ended_at is None:
        shift.ended_at = _now()
        shift.ended_by_user_id = current_user.id
        shift.auto_end_reason = "manual"
        db.commit()
        db.refresh(shift)
    return ShiftRead(**_serialize_shift(shift))


@me_router.patch("/api/shifts/{shift_id}/composition", response_model=ShiftRead)
def patch_composition(
    shift_id: int,
    payload: ShiftCompositionRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ShiftRead:
    """Mid-shift mode / crew edit. Recomputes deadline (sooner-only).

    Writes an audit row to ``shift_changes`` capturing before/after
    state of mode, crew, and deadline.
    """
    shift = db.query(Shift).filter(Shift.id == shift_id).first()
    if shift is None:
        raise HTTPException(status_code=404, detail="Shift not found")
    # Shared ownership: any crew member can edit composition.
    crew_ids = set(shift.crew_user_ids or [])
    if (
        shift.user_id != current_user.id
        and current_user.id not in crew_ids
        and current_user.role not in (RoleEnum.admin, RoleEnum.office)
    ):
        raise HTTPException(status_code=403, detail="Not your shift")
    if shift.ended_at is not None:
        raise HTTPException(status_code=400, detail="Cannot edit an ended shift")

    old_mode = shift.mode
    old_crew = list(shift.crew_user_ids or [])
    old_deadline = _aware(shift.next_deadline_at)

    new_mode = payload.mode
    new_crew = list(dict.fromkeys(payload.crew_user_ids or []))
    # If crew goes to zero, force mode = alone (UI also does this but
    # be defensive on the API).
    if new_mode == "crew" and not new_crew and not (payload.crew_freeform or "").strip():
        new_mode = "alone"

    new_deadline = deadline_for_mode_change(
        old_deadline=old_deadline or _now(),
        new_mode=new_mode,
        last_checkin_at=_aware(shift.last_checkin_at),
        started_at=_aware(shift.started_at) or _now(),
    )

    shift.mode = new_mode
    shift.crew_user_ids = new_crew
    shift.crew_freeform = payload.crew_freeform or ""
    shift.next_deadline_at = new_deadline

    change = ShiftChange(
        shift_id=shift.id,
        changed_by_user_id=current_user.id,
        old_mode=old_mode,
        new_mode=new_mode,
        old_crew=old_crew,
        new_crew=new_crew,
        old_deadline=old_deadline,
        new_deadline=new_deadline,
    )
    db.add(change)
    db.commit()
    db.refresh(shift)
    return ShiftRead(**_serialize_shift(shift))


@me_router.post("/api/checkins", response_model=CheckinRead)
def create_checkin(
    payload: CheckinCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> CheckinRead:
    """Record an "I'm OK" check-in against the user's active shift.

    Bumps ``shifts.last_checkin_at`` + recomputes ``next_deadline_at``.
    Returns 400 if no active shift (worker tried to check in without
    starting one).
    """
    shift = _get_user_today_shift(db, current_user.id)
    if shift is None:
        raise HTTPException(
            status_code=400,
            detail="No active shift. Start a shift (or join a crew) before checking in.",
        )
    now = _now()
    checkin = Checkin(
        shift_id=shift.id,
        user_id=current_user.id,
        lat=payload.lat,
        lon=payload.lon,
        accuracy_m=payload.accuracy_m,
        notes=payload.notes,
        created_at=now,
    )
    db.add(checkin)
    shift.last_checkin_at = now
    shift.next_deadline_at = compute_next_deadline(
        mode=shift.mode, last_checkin_at=now, started_at=_aware(shift.started_at)
    )
    db.commit()
    db.refresh(checkin)
    return CheckinRead(**_serialize_checkin(checkin))


@me_router.get("/api/checkins/me/preferences", response_model=PreferencesRead)
def get_my_prefs(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> PreferencesRead:
    """Return notification prefs + last-shift defaults for the calling user."""
    profile = _ensure_profile(db, current_user.id)
    return PreferencesRead(
        notify_push=profile.notify_push,
        notify_email=profile.notify_email,
        notify_email_address=profile.notify_email_address,
        last_mode=profile.last_mode,
        last_crew_user_ids=list(profile.last_crew_user_ids or []),
        auth_email=current_user.email,
    )


@me_router.put("/api/checkins/me/preferences", response_model=PreferencesRead)
def update_my_prefs(
    payload: PreferencesPayload,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> PreferencesRead:
    """Update notification prefs. All fields optional; only non-None update."""
    profile = _ensure_profile(db, current_user.id)
    profile.notify_push = payload.notify_push
    profile.notify_email = payload.notify_email
    profile.notify_email_address = (payload.notify_email_address or "").strip() or None
    if payload.last_mode is not None:
        profile.last_mode = payload.last_mode
    if payload.last_crew_user_ids is not None:
        profile.last_crew_user_ids = list(dict.fromkeys(payload.last_crew_user_ids))
    db.commit()
    db.refresh(profile)
    return PreferencesRead(
        notify_push=profile.notify_push,
        notify_email=profile.notify_email,
        notify_email_address=profile.notify_email_address,
        last_mode=profile.last_mode,
        last_crew_user_ids=list(profile.last_crew_user_ids or []),
        auth_email=current_user.email,
    )


@me_router.get(
    "/api/checkins/me/assignable-users",
    response_model=list[AssignableUserRead],
)
def list_crew_candidates(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[AssignableUserRead]:
    """Every other active user on the account, regardless of role.

    Drives the crew picker on the StartShift form. The picker includes
    workers, office, and admin users because admins and office staff
    routinely join field crews -- restricting to ``role=worker`` would
    hide those legitimate crewmates. The caller is excluded because
    you can't crew with yourself. Inactive (soft-deleted) users are
    excluded so abandoned accounts don't pollute the list.

    If a generic name like "Pineview Worker" appears here, that's a
    real `users` row that should be renamed or deleted in the User
    admin panel -- this endpoint just surfaces what's in the table.
    """
    query = db.query(User).filter(User.id != current_user.id)
    # `is_active` only exists if the User model defines it. Avoid a
    # hard reference so this works against legacy schemas without it.
    is_active_col = getattr(User, "is_active", None)
    if is_active_col is not None:
        query = query.filter(is_active_col.is_(True))
    rows = query.order_by(User.name.asc()).all()
    return [
        AssignableUserRead(id=u.id, name=u.name, email=u.email, role=u.role.value)
        for u in rows
    ]


@me_router.get("/api/push/vapid-public-key", response_model=VapidKeyResponse)
def get_vapid_public_key() -> VapidKeyResponse:
    """Expose the public VAPID key to the frontend.

    The frontend uses this as the ``applicationServerKey`` when calling
    ``pushManager.subscribe()``. The private half stays on the server.
    Returns empty string when push isn't configured -- the frontend
    treats this as "push unavailable" and hides the toggle.
    """
    return VapidKeyResponse(public_key=settings.vapid_public_key or "")


@me_router.post("/api/push/subscribe", status_code=204)
def subscribe_push(
    payload: PushSubscribePayload,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # No `-> None` return annotation on purpose: FastAPI 0.116+ would
    # interpret it as a declared empty response body, which trips the
    # framework's "204 must not have a response body" assertion at startup.
    """Upsert a Web Push subscription for the calling user.

    Endpoint is unique across the whole table -- if it already exists,
    update the user_id (in case the device was reused) and refresh the
    keys. New subscriptions are inserted.
    """
    existing = (
        db.query(PushSubscription)
        .filter(PushSubscription.endpoint == payload.endpoint)
        .first()
    )
    if existing is not None:
        existing.user_id = current_user.id
        existing.p256dh = payload.p256dh
        existing.auth = payload.auth
        existing.user_agent = payload.user_agent
    else:
        db.add(
            PushSubscription(
                user_id=current_user.id,
                endpoint=payload.endpoint,
                p256dh=payload.p256dh,
                auth=payload.auth,
                user_agent=payload.user_agent,
            )
        )
    db.commit()


@me_router.delete("/api/push/subscribe", status_code=204)
def unsubscribe_push(
    endpoint: str = Body(..., embed=True),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # See subscribe_push above for why no `-> None` annotation.
    """Delete the calling user's subscription for ``endpoint``. Idempotent."""
    db.query(PushSubscription).filter(
        PushSubscription.endpoint == endpoint,
        PushSubscription.user_id == current_user.id,
    ).delete()
    db.commit()


# ──────────────────────────────────────────────────────────────────────
# /api/admin/*   (admin / office)
# ──────────────────────────────────────────────────────────────────────


@admin_router.get("/api/admin/checkin-overview", response_model=list[OverviewEntry])
def get_overview(db: Session = Depends(get_db)) -> list[OverviewEntry]:
    """Overview tab: anyone with an active shift today OR assigned to an
    active truck. One row per user. Single round-trip.
    """
    # Set 1: users with an active shift (auto-end resolved on the way in).
    active_shifts = (
        db.query(Shift).filter(Shift.ended_at.is_(None)).all()
    )
    for s in active_shifts:
        _resolve_shift_state(db, s)
    shift_by_user: dict[int, Shift] = {
        s.user_id: s for s in active_shifts if s.ended_at is None
    }

    # Set 2: users assigned to an active device (truck).
    assigned_rows = (
        db.query(Device)
        .filter(
            Device.assigned_user_id.is_not(None),
            Device.is_active.is_(True),
        )
        .all()
    )
    truck_by_user: dict[int, Device] = {}
    for d in assigned_rows:
        # If a user has multiple trucks (shouldn't happen but possible),
        # keep the most recently seen one.
        existing = truck_by_user.get(d.assigned_user_id)
        if existing is None or (
            d.last_seen_at and (not existing.last_seen_at or d.last_seen_at > existing.last_seen_at)
        ):
            truck_by_user[d.assigned_user_id] = d

    user_ids = set(shift_by_user.keys()) | set(truck_by_user.keys())
    if not user_ids:
        return []

    # Widen the user lookup to also include every crew teammate so the
    # serializer can embed their names into ShiftRead.crew_members. A
    # crew teammate doesn't necessarily have their own shift today, so
    # they won't already be in user_ids.
    lookup_ids: set[int] = set(user_ids)
    for sh in shift_by_user.values():
        for cid in (sh.crew_user_ids or []):
            lookup_ids.add(cid)

    users = db.query(User).filter(User.id.in_(lookup_ids)).all()
    user_by_id = {u.id: u for u in users}

    out: list[OverviewEntry] = []
    for uid in user_ids:
        user = user_by_id.get(uid)
        if user is None:
            continue
        shift = shift_by_user.get(uid)
        truck = truck_by_user.get(uid)
        shift_serial = (
            _serialize_shift(shift, user=user, users_by_id=user_by_id)
            if shift else None
        )
        # Tier: if there's a live shift, use compliance tier.
        # Else 'idle' (truck-assigned but not started).
        tier_value = shift_serial["status_tier"] if shift_serial else "idle"
        out.append(
            OverviewEntry(
                user_id=uid,
                display_name=user.name,
                role=user.role.value,
                avatar_seed=user.email or user.name,
                shift=ShiftRead(**shift_serial) if shift_serial else None,
                truck_id=truck.id if truck else None,
                truck_label=truck.label if truck else None,
                truck_color=truck.color_hex if truck else None,
                truck_last_seen_at=_aware(truck.last_seen_at) if truck else None,
                truck_lat=truck.last_lat if truck else None,
                truck_lon=truck.last_lng if truck else None,
                status_tier=tier_value,
            )
        )
    # Sort: red -> yellow -> blue -> green -> idle -> off, then name.
    rank = {"red": 0, "yellow": 1, "blue": 2, "green": 3, "idle": 4, "off": 5}
    out.sort(key=lambda e: (rank.get(e.status_tier, 9), e.display_name.lower()))
    return out


@admin_router.get("/api/admin/shifts/active", response_model=list[ShiftRead])
def list_active_shifts(db: Session = Depends(get_db)) -> list[ShiftRead]:
    """All active shifts (after lazy auto-end). Drives the Active tab.

    Embeds ``user_name`` / ``user_email`` so the dashboard renders real
    names instead of "User #N".
    """
    rows = db.query(Shift).filter(Shift.ended_at.is_(None)).all()
    resolved_rows = []
    for s in rows:
        resolved = _resolve_shift_state(db, s)
        if resolved.ended_at is None:
            resolved_rows.append(resolved)
    # Collect lead + crew ids in a single batch so ShiftRead.crew_members
    # gets resolved names without N+1 queries.
    all_ids: list[int] = []
    for s in resolved_rows:
        all_ids.append(s.user_id)
        all_ids.extend(s.crew_user_ids or [])
    user_map = _users_by_id(db, all_ids)
    return [
        ShiftRead(**_serialize_shift(
            s, user=user_map.get(s.user_id), users_by_id=user_map,
        ))
        for s in resolved_rows
    ]


@admin_router.get("/api/admin/shifts", response_model=list[ShiftRead])
def list_shifts_by_date(
    date_str: Optional[str] = Query(None, alias="date"),
    db: Session = Depends(get_db),
) -> list[ShiftRead]:
    """History tab: shifts active during the given local-Vancouver date.

    See ``list_active_shifts`` for the user_name embedding rationale.
    """
    target = None
    if date_str:
        try:
            target = date.fromisoformat(date_str)
        except ValueError:
            raise HTTPException(status_code=400, detail="Bad date (use YYYY-MM-DD)")
    start, end = _local_day_window(target)
    # Active during the day = started_at < end AND (ended_at IS NULL OR ended_at >= start)
    rows = (
        db.query(Shift)
        .filter(
            Shift.started_at < end,
            or_(Shift.ended_at.is_(None), Shift.ended_at >= start),
        )
        .order_by(Shift.started_at.desc())
        .all()
    )
    # Same batch-fetch pattern as list_active_shifts: include crew ids
    # so the History tab can render crew member names per row.
    all_ids: list[int] = []
    for s in rows:
        all_ids.append(s.user_id)
        all_ids.extend(s.crew_user_ids or [])
    user_map = _users_by_id(db, all_ids)
    return [
        ShiftRead(**_serialize_shift(
            s, user=user_map.get(s.user_id), users_by_id=user_map,
        ))
        for s in rows
    ]


@admin_router.post("/api/admin/shifts/{shift_id}/end", response_model=ShiftRead)
def admin_end_shift(
    shift_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ShiftRead:
    """Force-end any shift. Records auto_end_reason='admin_override'."""
    shift = db.query(Shift).filter(Shift.id == shift_id).first()
    if shift is None:
        raise HTTPException(status_code=404, detail="Shift not found")
    if shift.ended_at is None:
        shift.ended_at = _now()
        shift.ended_by_user_id = current_user.id
        shift.auto_end_reason = "admin_override"
        db.commit()
        db.refresh(shift)
    return ShiftRead(**_serialize_shift(shift))


@admin_router.post("/api/admin/shifts/{shift_id}/checkin", response_model=CheckinRead)
def admin_force_checkin(
    shift_id: int,
    payload: CheckinCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> CheckinRead:
    """Admin records a check-in on a worker's behalf (rare safety override).

    Sets recorded_by_user_id so the audit trail shows it was an override.
    """
    shift = db.query(Shift).filter(Shift.id == shift_id).first()
    if shift is None:
        raise HTTPException(status_code=404, detail="Shift not found")
    if shift.ended_at is not None:
        raise HTTPException(status_code=400, detail="Cannot check in on an ended shift")
    now = _now()
    checkin = Checkin(
        shift_id=shift.id,
        user_id=shift.user_id,
        recorded_by_user_id=current_user.id,
        lat=payload.lat,
        lon=payload.lon,
        accuracy_m=payload.accuracy_m,
        notes=payload.notes,
        created_at=now,
    )
    db.add(checkin)
    shift.last_checkin_at = now
    shift.next_deadline_at = compute_next_deadline(
        mode=shift.mode, last_checkin_at=now, started_at=_aware(shift.started_at)
    )
    db.commit()
    db.refresh(checkin)
    return CheckinRead(**_serialize_checkin(checkin))


# -- Office alert recipient management ----------------------------------


def _list_recipients(db: Session) -> list[OfficeAlertRecipient]:
    """Primary first, then others alphabetical (consistent UI order)."""
    rows = db.query(OfficeAlertRecipient).all()
    rows.sort(key=lambda r: (0 if r.is_primary else 1, (r.email or "").lower()))
    return rows


@admin_router.get(
    "/api/admin/checkin-recipients", response_model=list[RecipientRead]
)
def list_recipients(db: Session = Depends(get_db)) -> list[RecipientRead]:
    return [RecipientRead.model_validate(r) for r in _list_recipients(db)]


@admin_router.post(
    "/api/admin/checkin-recipients", response_model=RecipientRead, status_code=201
)
def add_recipient(
    payload: RecipientCreate,
    db: Session = Depends(get_db),
) -> RecipientRead:
    """Add a non-primary recipient. Primary is managed via the separate
    /primary endpoint to make the always-on contract explicit."""
    existing = (
        db.query(OfficeAlertRecipient)
        .filter(OfficeAlertRecipient.email == payload.email)
        .first()
    )
    if existing is not None:
        raise HTTPException(status_code=409, detail="Recipient already exists")
    row = OfficeAlertRecipient(
        email=payload.email,
        display_name=payload.display_name,
        is_active=payload.is_active,
        is_primary=False,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return RecipientRead.model_validate(row)


@admin_router.put(
    "/api/admin/checkin-recipients/{recipient_id}", response_model=RecipientRead
)
def update_recipient(
    recipient_id: int,
    payload: RecipientUpdate,
    db: Session = Depends(get_db),
) -> RecipientRead:
    """Update a recipient. Returns 400 if attempting to deactivate the primary."""
    row = (
        db.query(OfficeAlertRecipient)
        .filter(OfficeAlertRecipient.id == recipient_id)
        .first()
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Recipient not found")
    if row.is_primary and payload.is_active is False:
        raise HTTPException(
            status_code=400,
            detail="The primary office email is always active. Use the primary endpoint to change it.",
        )
    if payload.email is not None:
        row.email = payload.email
    if payload.display_name is not None:
        row.display_name = payload.display_name
    if payload.is_active is not None:
        row.is_active = payload.is_active
    db.commit()
    db.refresh(row)
    return RecipientRead.model_validate(row)


@admin_router.delete(
    "/api/admin/checkin-recipients/{recipient_id}", status_code=204
)
def delete_recipient(recipient_id: int, db: Session = Depends(get_db)):
    # No `-> None`: see subscribe_push for the FastAPI 0.116+ assertion.
    row = (
        db.query(OfficeAlertRecipient)
        .filter(OfficeAlertRecipient.id == recipient_id)
        .first()
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Recipient not found")
    if row.is_primary:
        raise HTTPException(
            status_code=400,
            detail="The primary office email cannot be deleted, only edited.",
        )
    db.delete(row)
    db.commit()


@admin_router.post(
    "/api/admin/checkin-recipients/primary",
    response_model=RecipientRead,
)
def upsert_primary_recipient(
    payload: RecipientPrimaryUpsert,
    db: Session = Depends(get_db),
) -> RecipientRead:
    """Set or replace the always-on primary office email.

    If a primary row exists, update its email + display_name. Else create
    one. Idempotent. Conflicts with an existing non-primary row of the
    same email are resolved by promoting that row to primary.
    """
    current_primary = (
        db.query(OfficeAlertRecipient)
        .filter(OfficeAlertRecipient.is_primary.is_(True))
        .first()
    )
    same_email = (
        db.query(OfficeAlertRecipient)
        .filter(OfficeAlertRecipient.email == payload.email)
        .first()
    )
    if current_primary is not None and same_email is not None and current_primary.id != same_email.id:
        # The new email belongs to a non-primary row. Promote it and
        # demote the old primary (or delete it if you'd rather; we
        # demote to preserve history -- admin can manually remove).
        current_primary.is_primary = False
        same_email.is_primary = True
        same_email.is_active = True
        same_email.display_name = payload.display_name or same_email.display_name
        db.commit()
        db.refresh(same_email)
        return RecipientRead.model_validate(same_email)
    if current_primary is not None:
        current_primary.email = payload.email
        current_primary.display_name = payload.display_name or current_primary.display_name
        current_primary.is_active = True
        db.commit()
        db.refresh(current_primary)
        return RecipientRead.model_validate(current_primary)
    if same_email is not None:
        same_email.is_primary = True
        same_email.is_active = True
        same_email.display_name = payload.display_name or same_email.display_name
        db.commit()
        db.refresh(same_email)
        return RecipientRead.model_validate(same_email)
    row = OfficeAlertRecipient(
        email=payload.email,
        display_name=payload.display_name,
        is_active=True,
        is_primary=True,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return RecipientRead.model_validate(row)


# ──────────────────────────────────────────────────────────────────────
# /api/admin/checkins/vapid-status   (admin-only VAPID config diagnostic)
# ──────────────────────────────────────────────────────────────────────


class VapidStatusResponse(BaseModel):
    """Diagnostic output for the VAPID keypair validation endpoint."""
    public_key_set: bool
    private_key_set: bool
    contact_email_set: bool
    stored_public_key: Optional[str] = None
    stored_public_length: int = 0
    derived_public_key: Optional[str] = None
    derived_public_length: int = 0
    keys_match: bool = False
    private_key_format: Optional[str] = None
    error: Optional[str] = None


@admin_router.get(
    "/api/admin/checkins/vapid-status", response_model=VapidStatusResponse
)
def admin_vapid_status() -> VapidStatusResponse:
    """Verify that VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are a matched
    pair by deriving the public key from the private key and comparing.

    This is the definitive diagnostic for 403 "bad JWT token" failures
    from Apple/FCM. Apple validates each push's JWT signature against
    the VAPID public key the subscription was registered with; if the
    backend's private key isn't the mathematical partner of that public
    key, every push will 403 forever.

    Surface the derived public key alongside the stored one so the admin
    can paste them into a diff tool if needed.
    """
    import base64
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec

    stored_pub = (settings.vapid_public_key or "").strip()
    priv = (settings.vapid_private_key or "").strip()
    contact = (settings.vapid_contact_email or "").strip()

    resp = VapidStatusResponse(
        public_key_set=bool(stored_pub),
        private_key_set=bool(priv),
        contact_email_set=bool(contact),
        stored_public_key=stored_pub if stored_pub else None,
        stored_public_length=len(stored_pub),
    )
    if not stored_pub or not priv:
        resp.error = "VAPID public or private key is not configured."
        return resp

    # Parse the private key. The generate_vapid_keys.py script emits the
    # raw 32-byte EC scalar as base64url. PEM is also accepted. Try the
    # base64url path first (no newlines = friendlier for .env).
    private_key_obj = None
    fmt = None
    try:
        # base64url with optional padding stripped
        padding = "=" * ((4 - (len(priv) % 4)) % 4)
        d_bytes = base64.urlsafe_b64decode(priv + padding)
        if len(d_bytes) == 32:
            d_int = int.from_bytes(d_bytes, "big")
            private_key_obj = ec.derive_private_key(d_int, ec.SECP256R1())
            fmt = "base64url-d-value"
    except Exception:  # noqa: BLE001 -- try PEM next
        private_key_obj = None

    if private_key_obj is None:
        try:
            private_key_obj = serialization.load_pem_private_key(
                priv.encode("utf-8"), password=None
            )
            fmt = "PEM"
        except Exception as exc:  # noqa: BLE001 -- definitive failure
            resp.error = f"Could not parse VAPID private key: {exc}"
            return resp

    resp.private_key_format = fmt

    # Derive the matching public key and compare to the stored value.
    derived_bytes = private_key_obj.public_key().public_bytes(
        encoding=serialization.Encoding.X962,
        format=serialization.PublicFormat.UncompressedPoint,
    )
    derived_b64 = (
        base64.urlsafe_b64encode(derived_bytes).rstrip(b"=").decode("ascii")
    )
    resp.derived_public_key = derived_b64
    resp.derived_public_length = len(derived_b64)
    resp.keys_match = stored_pub == derived_b64
    if not resp.keys_match:
        resp.error = (
            "VAPID public/private key MISMATCH. The backend's private "
            "key does not mathematically match the public key the "
            "frontend is using. Regenerate both keys together and "
            "update Render env vars."
        )
    return resp


# ──────────────────────────────────────────────────────────────────────
# /api/admin/checkins/test-push   (admin-only push diagnostic)
# ──────────────────────────────────────────────────────────────────────


class TestPushEndpointResult(BaseModel):
    """Per-subscription outcome for the test-push diagnostic.

    ``ok`` is True when pywebpush accepted the push without raising
    (i.e. the upstream push service returned 2xx). It does NOT mean
    the device received it -- Apple in particular accepts pushes for
    stale subscriptions then silently drops them.
    """
    id: int
    user_agent: Optional[str] = None
    push_service: str
    ok: bool
    deleted: bool = False
    error: Optional[str] = None
    status_code: Optional[int] = None
    response_body: Optional[str] = None


class TestPushResponse(BaseModel):
    push_configured: bool
    sub_count: int
    results: list[TestPushEndpointResult]


def _classify_push_endpoint(endpoint: str) -> str:
    """Map a push endpoint URL to a human-readable push service name.

    Mirrors the SQL CASE used in the dashboard so the UI labels match.
    """
    if "web.push.apple.com" in endpoint:
        return "iOS / Safari (Apple)"
    if "fcm.googleapis.com" in endpoint:
        return "Android / Chrome (Google FCM)"
    if "mozilla.com" in endpoint:
        return "Firefox (Mozilla)"
    if "notify.windows.com" in endpoint:
        return "Windows (WNS)"
    return "Unknown"


@admin_router.post(
    "/api/admin/checkins/test-push", response_model=TestPushResponse
)
def admin_test_push(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> TestPushResponse:
    """Send a test push to every push subscription registered for the
    calling admin's user account, returning per-endpoint diagnostic info.

    Lets the admin verify the push pipeline end-to-end (VAPID keys,
    network, service worker, OS-level notification permission) without
    needing an overdue shift to fire a real alert. The test push uses
    the same ``checkin`` tag as real alerts so it visually replaces any
    prior check-in notification in the OS tray.
    """
    results: list[TestPushEndpointResult] = []
    subs = (
        db.query(PushSubscription)
        .filter(PushSubscription.user_id == current_user.id)
        .all()
    )
    if not push_configured():
        return TestPushResponse(
            push_configured=False, sub_count=len(subs), results=[]
        )

    from pywebpush import WebPushException, webpush  # type: ignore[import-untyped]

    payload = PushPayload(
        title="Pineview Maps test push",
        body="If you see this, push notifications are working on this device.",
        tag="checkin",
        urgent=False,
        url="/",
        shift_id=None,
    )
    vapid_claims = {"sub": f"mailto:{settings.vapid_contact_email}"}
    for sub in subs:
        sub_id = sub.id
        ua = sub.user_agent
        service = _classify_push_endpoint(sub.endpoint or "")
        sub_info = {
            "endpoint": sub.endpoint,
            "keys": {"p256dh": sub.p256dh, "auth": sub.auth},
        }
        # Direct webpush() call (NOT via send_push) so we capture the
        # full upstream response BEFORE the cleanup deletes the row.
        # We still mirror the cleanup logic afterward so admin and prod
        # behavior stay aligned.
        try:
            webpush(
                subscription_info=sub_info,
                data=payload.to_json(),
                vapid_private_key=settings.vapid_private_key,
                vapid_claims=vapid_claims,
                ttl=60 * 60,
            )
        except WebPushException as exc:
            status_code = getattr(exc.response, "status_code", None)
            response_body: Optional[str] = None
            try:
                response_body = getattr(exc.response, "text", None)
                if response_body and len(response_body) > 500:
                    response_body = response_body[:500] + "…"
            except Exception:  # noqa: BLE001
                response_body = None
            deleted = False
            if status_code in (401, 403, 404, 410):
                db.delete(sub)
                db.commit()
                deleted = True
            results.append(
                TestPushEndpointResult(
                    id=sub_id,
                    user_agent=ua,
                    push_service=service,
                    ok=False,
                    deleted=deleted,
                    error=str(exc),
                    status_code=status_code,
                    response_body=response_body,
                )
            )
            logger.warning(
                "Test push to sub %s (%s) failed: status=%s body=%s",
                sub_id, service, status_code, response_body,
            )
            continue
        except Exception as exc:  # noqa: BLE001 -- non-WebPush failure
            results.append(
                TestPushEndpointResult(
                    id=sub_id,
                    user_agent=ua,
                    push_service=service,
                    ok=False,
                    deleted=False,
                    error=f"Unexpected error: {exc}",
                )
            )
            logger.warning(
                "Test push to sub %s (%s) raised non-WebPush exception: %s",
                sub_id, service, exc,
            )
            continue
        results.append(
            TestPushEndpointResult(
                id=sub_id,
                user_agent=ua,
                push_service=service,
                ok=True,
                deleted=False,
            )
        )
    return TestPushResponse(
        push_configured=True, sub_count=len(subs), results=results
    )


# ──────────────────────────────────────────────────────────────────────
# /api/checkins/scan   (cron, shared-secret auth)
# ──────────────────────────────────────────────────────────────────────


def _ensure_seed_primary(db: Session) -> None:
    """If OFFICE_PRIMARY_EMAIL env var is set and no primary exists, seed it."""
    if not settings.office_primary_email:
        return
    existing_primary = (
        db.query(OfficeAlertRecipient)
        .filter(OfficeAlertRecipient.is_primary.is_(True))
        .first()
    )
    if existing_primary is not None:
        return
    same = (
        db.query(OfficeAlertRecipient)
        .filter(OfficeAlertRecipient.email == settings.office_primary_email)
        .first()
    )
    if same is not None:
        same.is_primary = True
        same.is_active = True
    else:
        db.add(
            OfficeAlertRecipient(
                email=settings.office_primary_email,
                display_name="Office (auto-seeded)",
                is_active=True,
                is_primary=True,
            )
        )
    db.commit()


def _active_recipient_emails(db: Session) -> list[str]:
    """All emails that should receive an office alert right now."""
    rows = (
        db.query(OfficeAlertRecipient)
        .filter(OfficeAlertRecipient.is_active.is_(True))
        .all()
    )
    return [r.email for r in rows if r.email]


def _alert_exists(db: Session, shift_id: int, kind: str) -> bool:
    """True if a checkin_alerts row already exists for this (shift, kind)."""
    row = (
        db.query(CheckinAlert.id)
        .filter(
            CheckinAlert.shift_id == shift_id,
            CheckinAlert.kind == kind,
        )
        .first()
    )
    return row is not None


def _log_alert(
    db: Session,
    *,
    shift_id: int,
    kind: str,
    due_at: datetime,
    channel: str,
    recipient: str,
    result: str = "sent",
    error: Optional[str] = None,
) -> None:
    db.add(
        CheckinAlert(
            shift_id=shift_id,
            kind=kind,
            due_at=due_at,
            channel=channel,
            recipient=recipient,
            result=result,
            error=error,
        )
    )
    db.commit()


def _format_crew_names(db: Session, shift: Shift) -> str:
    """Comma-joined crew display names (users + free-text)."""
    parts: list[str] = []
    if shift.crew_user_ids:
        rows = (
            db.query(User)
            .filter(User.id.in_(list(shift.crew_user_ids)))
            .all()
        )
        parts.extend(u.name for u in rows)
    if shift.crew_freeform:
        for line in str(shift.crew_freeform).splitlines():
            stripped = line.strip()
            if stripped:
                parts.append(stripped)
    return ", ".join(parts)


def _dashboard_url() -> str:
    base = (settings.frontend_url or "").rstrip("/")
    return f"{base}/?openCheckinsDashboard=1" if base else ""


def _run_sync_email(coro) -> None:
    """Run an async email send from the sync scan endpoint."""
    try:
        asyncio.run(coro)
    except RuntimeError:
        # Already inside a loop -- shouldn't happen in our sync route
        # but cover the case.
        loop = asyncio.new_event_loop()
        try:
            loop.run_until_complete(coro)
        finally:
            loop.close()


@cron_router.post("/api/checkins/scan", response_model=ScanResponse)
def scan_checkins(
    x_checkin_scan_secret: Optional[str] = Header(default=None, alias="Authorization"),
    db: Session = Depends(get_db),
) -> ScanResponse:
    """Cron entrypoint: every minute, walk active shifts and fire any alerts
    that just crossed a threshold. Idempotent via the ``checkin_alerts`` ledger.

    Auth: bearer token in Authorization header (``Bearer <CHECKIN_SCAN_SECRET>``).
    """
    expected = settings.checkin_scan_secret
    if not expected:
        raise HTTPException(
            status_code=503,
            detail="CHECKIN_SCAN_SECRET is not configured on the server.",
        )
    # Accept either "Bearer X" or raw secret in the header.
    provided = (x_checkin_scan_secret or "").strip()
    if provided.lower().startswith("bearer "):
        provided = provided[7:].strip()
    if provided != expected:
        raise HTTPException(status_code=403, detail="Invalid scan secret")

    _ensure_seed_primary(db)

    response = ScanResponse()
    now = _now()
    office_recipients = _active_recipient_emails(db)

    rows = db.query(Shift).filter(Shift.ended_at.is_(None)).all()
    response.scanned = len(rows)

    for shift in rows:
        # Auto-end first -- may close out the row before any alert.
        resolved = _resolve_shift_state(db, shift)
        if resolved.ended_at is not None:
            response.auto_ended += 1
            continue
        if resolved.mode == "off":
            continue

        deadline = _aware(resolved.next_deadline_at)
        if deadline is None:
            continue
        minutes_overdue = (now - deadline).total_seconds() / 60.0

        # Resolve worker target + crew mates once per shift.
        worker_row = (
            db.query(User).filter(User.id == resolved.user_id).first()
        )
        if worker_row is None:
            continue
        crew_user_map = _users_by_id(
            db, list(resolved.crew_user_ids or [])
        )
        crew_targets = list(crew_user_map.values())

        # -- Worker alerts ------------------------------------------------
        for spec in WORKER_ALERTS:
            # threshold_minutes is signed: negative = before deadline.
            if minutes_overdue + 0.5 >= spec.threshold_minutes and not _alert_exists(db, resolved.id, spec.kind):
                _send_worker_alert(
                    db,
                    shift=resolved,
                    user=worker_row,
                    crew_users=crew_targets,
                    kind=spec.kind,
                    urgent=spec.urgent,
                    minutes_overdue=int(minutes_overdue),
                    response=response,
                )
        # Repeat overdue alerts beyond T+3.
        for repeat_kind in overdue_repeat_kinds(minutes_overdue):
            if not _alert_exists(db, resolved.id, repeat_kind):
                _send_worker_alert(
                    db,
                    shift=resolved,
                    user=worker_row,
                    crew_users=crew_targets,
                    kind=repeat_kind,
                    urgent=True,
                    minutes_overdue=int(minutes_overdue),
                    response=response,
                )

        # -- Office alerts ------------------------------------------------
        for spec in OFFICE_ALERTS:
            if minutes_overdue + 0.5 >= spec.threshold_minutes and not _alert_exists(db, resolved.id, spec.kind):
                _send_office_alert(
                    db,
                    shift=resolved,
                    worker=worker_row,
                    kind=spec.kind,
                    urgent=spec.urgent,
                    minutes_overdue=int(minutes_overdue),
                    recipients=office_recipients,
                    response=response,
                )
        for repeat_kind in office_repeat_kinds(minutes_overdue):
            if not _alert_exists(db, resolved.id, repeat_kind):
                _send_office_alert(
                    db,
                    shift=resolved,
                    worker=worker_row,
                    kind=repeat_kind,
                    urgent=True,
                    minutes_overdue=int(minutes_overdue),
                    recipients=office_recipients,
                    response=response,
                )

    return response


def _send_worker_alert(
    db: Session,
    *,
    shift: Shift,
    user: User,
    crew_users: list[User] = [],
    kind: str,
    urgent: bool,
    minutes_overdue: int,
    response: ScanResponse,
) -> None:
    """Push + (optional) email to the lead AND every crew member.

    The alert ledger (``checkin_alerts``) logs once per shift per kind,
    not per recipient — the threshold was crossed once regardless of
    how many people get notified. Crew members receive the same push /
    email as the lead so any of them can tap "I'm OK" on behalf of the
    crew (the user's "I told Mark to check in for me" scenario).
    """
    deadline = _aware(shift.next_deadline_at) or _now()
    title_map = {
        "worker_t-15": "Check-in due in 15 minutes",
        "worker_t0": "Check-in due now",
        "worker_overdue_3": "OVERDUE — please check in",
    }
    title = title_map.get(kind, "OVERDUE — please check in")
    body_for_push = (
        f"You're {minutes_overdue} min overdue. Tap I'm OK."
        if minutes_overdue >= 1
        else "Open Pineview Maps and tap I'm OK."
    )

    def _push_to(u: User) -> int:
        """Return number of endpoints successfully delivered."""
        try:
            eps = _fanout_push(
                db,
                user_id=u.id,
                title=title,
                body=body_for_push,
                urgent=urgent,
                shift_id=shift.id,
            )
            return len(eps) if eps else 0
        except Exception as exc:
            logger.warning(
                "Worker push for shift %s kind %s user %s failed: %s",
                shift.id, kind, u.id, exc,
            )
            response.errors += 1
            return 0

    def _email_to(u: User) -> bool:
        target = _resolve_notify_email(db, u)
        if not target:
            return False
        try:
            _run_sync_email(
                send_checkin_reminder_email(
                    target,
                    worker_name=u.name,
                    kind=kind,
                    due_at=deadline,
                )
            )
            return True
        except Exception as exc:
            logger.warning(
                "Worker email for shift %s kind %s user %s failed: %s",
                shift.id, kind, u.id, exc,
            )
            response.errors += 1
            return False

    # -- Lead ----------------------------------------------------------
    sent_any = False
    if _push_to(user):
        sent_any = True
        response.worker_alerts_sent += 1
    if _email_to(user):
        sent_any = True

    # -- Crew members --------------------------------------------------
    for crew in crew_users:
        if _push_to(crew):
            sent_any = True
            response.worker_alerts_sent += 1
        if _email_to(crew):
            sent_any = True

    # Log once per shift per kind so the scanner doesn't retry.
    if sent_any:
        _log_alert(
            db,
            shift_id=shift.id,
            kind=kind,
            due_at=deadline,
            channel="push",
            recipient=str(user.id),
        )
    elif not _alert_exists(db, shift.id, kind):
        _log_alert(
            db,
            shift_id=shift.id,
            kind=kind,
            due_at=deadline,
            channel="none",
            recipient=str(user.id),
            result="skipped",
        )


def _send_office_alert(
    db: Session,
    *,
    shift: Shift,
    worker: User,
    kind: str,
    urgent: bool,
    minutes_overdue: int,
    recipients: list[str],
    response: ScanResponse,
) -> None:
    """Email every active office recipient for a single alert kind."""
    deadline = _aware(shift.next_deadline_at) or _now()
    if not recipients:
        # Mark as skipped so we don't retry every minute when no
        # recipients are configured.
        _log_alert(
            db,
            shift_id=shift.id,
            kind=kind,
            due_at=deadline,
            channel="none",
            recipient="",
            result="skipped",
            error="no recipients configured",
        )
        return

    crew_names = _format_crew_names(db, shift)
    dashboard_url = _dashboard_url()
    for to in recipients:
        try:
            if urgent or kind == "office_urgent" or kind.startswith("office_repeat_"):
                _run_sync_email(
                    send_office_overdue_email_urgent(
                        to,
                        worker_name=worker.name,
                        mode=shift.mode,
                        crew_names=crew_names,
                        deadline_at=deadline,
                        minutes_overdue=minutes_overdue,
                        dashboard_url=dashboard_url,
                    )
                )
            else:
                _run_sync_email(
                    send_office_overdue_email_standard(
                        to,
                        worker_name=worker.name,
                        mode=shift.mode,
                        crew_names=crew_names,
                        deadline_at=deadline,
                        minutes_overdue=minutes_overdue,
                        dashboard_url=dashboard_url,
                    )
                )
            _log_alert(
                db,
                shift_id=shift.id,
                kind=f"{kind}__{to}",
                due_at=deadline,
                channel="email",
                recipient=to,
            )
        except Exception as exc:
            logger.warning(
                "Office email to %s for shift %s kind %s failed: %s",
                to,
                shift.id,
                kind,
                exc,
            )
            response.errors += 1

    # Always log a top-level row for the kind so idempotency works at the
    # shift level (not per-recipient). Lets us add/remove recipients
    # without re-sending earlier alerts.
    _log_alert(
        db,
        shift_id=shift.id,
        kind=kind,
        due_at=deadline,
        channel="email",
        recipient=",".join(recipients[:5]),
    )
    response.office_alerts_sent += 1
