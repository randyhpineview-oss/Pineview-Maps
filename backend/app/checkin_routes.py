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
      - POST   /api/checkins/me/test-push
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
from sqlalchemy import and_, cast, func, or_, select
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Session
from supabase import create_client

from app.auth import DEV_ACCOUNT_EMAIL, MANAGES_PINS, get_current_user, is_dev_email, require_roles
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
    ShiftMemberLocation,
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
from app.push_service import PushPayload, push_configured, send_push, vapid_sub_claim

settings = get_settings()
logger = get_logger(__name__)
VANCOUVER = ZoneInfo("America/Vancouver")


# Routers --------------------------------------------------------------
me_router = APIRouter(
    tags=["checkins-me"],
    dependencies=[Depends(require_roles(RoleEnum.admin, RoleEnum.office, RoleEnum.crew_lead, RoleEnum.worker))],
)
# Crew leads can READ the dashboard (overview/active/history/recipients)
# but cannot mutate it. The router admits MANAGES_PINS; each mutating
# endpoint adds an extra office/admin-only dep below.
admin_router = APIRouter(
    tags=["checkins-admin"],
    dependencies=[Depends(require_roles(*MANAGES_PINS))],
)

# Reusable per-endpoint guard for mutating admin actions (force check-in,
# end shift, edit recipient list, send test push). Stacks on top of the
# router-level MANAGES_PINS check to reject crew_lead with 403.
require_office_admin = Depends(require_roles(RoleEnum.admin, RoleEnum.office))

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
        "last_loc_lat": shift.last_loc_lat,
        "last_loc_lon": shift.last_loc_lon,
        "last_loc_accuracy_m": (
            float(shift.last_loc_accuracy_m)
            if shift.last_loc_accuracy_m is not None else None
        ),
        "last_loc_at": _aware(shift.last_loc_at),
    }


def _alert_severity(kind: str) -> str:
    """Bucket a checkin_alerts.kind into a coarse severity for the
    History timeline pill. Mirrors the cadence in ``checkin_cadence.py``
    so worker-side T-15 reminders stay visually distinct from "office
    has been paged" escalations.

    Buckets:
      * 'reminder' — worker_t-15 (heads up, not yet overdue)
      * 'due'      — worker_t0   (deadline passed, first nudge)
      * 'overdue'  — worker_overdue_*, office_first (action needed)
      * 'urgent'   — office_urgent (call them, >60 min overdue)
    """
    if kind == "worker_t-15":
        return "reminder"
    if kind == "worker_t0":
        return "due"
    if kind.startswith("office_urgent"):
        return "urgent"
    if kind.startswith("worker_overdue") or kind.startswith("office"):
        return "overdue"
    return "overdue"


def _embed_shift_events(
    db: Session,
    serialized_shifts: list[dict],
    users_by_id: Optional[dict[int, User]] = None,
) -> None:
    """Batch-attach ``checkins`` and ``missed_events`` arrays onto each
    serialized shift dict in-place.

    Two queries total regardless of shift count:
      1. ``Checkin`` rows where shift_id IN (...), ordered by created_at.
      2. ``CheckinAlert`` rows where shift_id IN (...) and kind targets
         the worker (T-15, T0, repeats) OR office (first, urgent). We
         pull both because the History timeline shows the full escalation
         path in one place.

    ``users_by_id`` (when provided) lets us resolve check-in user names
    without an extra query -- the calling admin endpoints already build
    this map for crew_members embedding so reusing it is free.
    """
    if not serialized_shifts:
        return
    shift_ids = [s["id"] for s in serialized_shifts]

    # Widen the user lookup so a check-in's user_name resolves even if
    # the user wasn't in the lead/crew set the caller pre-fetched.
    extra_user_ids: set[int] = set()
    checkin_rows = (
        db.query(Checkin)
        .filter(Checkin.shift_id.in_(shift_ids))
        .order_by(Checkin.created_at.asc())
        .all()
    )
    for c in checkin_rows:
        if users_by_id is None or c.user_id not in users_by_id:
            extra_user_ids.add(c.user_id)
        if c.recorded_by_user_id and (
            users_by_id is None or c.recorded_by_user_id not in users_by_id
        ):
            extra_user_ids.add(c.recorded_by_user_id)
    if extra_user_ids:
        rows = db.query(User).filter(User.id.in_(extra_user_ids)).all()
        if users_by_id is None:
            users_by_id = {}
        for u in rows:
            users_by_id[u.id] = u

    # Index check-ins by shift_id so the per-shift loop below is O(1).
    by_shift: dict[int, list[dict]] = {sid: [] for sid in shift_ids}
    for c in checkin_rows:
        u = (users_by_id or {}).get(c.user_id)
        recorder = (
            (users_by_id or {}).get(c.recorded_by_user_id)
            if c.recorded_by_user_id else None
        )
        by_shift[c.shift_id].append({
            "id": c.id,
            "user_id": c.user_id,
            "user_name": u.name if u else None,
            "recorded_by_user_id": c.recorded_by_user_id,
            "recorded_by_name": recorder.name if recorder else None,
            "lat": c.lat,
            "lon": c.lon,
            "accuracy_m": float(c.accuracy_m) if c.accuracy_m is not None else None,
            "notes": c.notes,
            "created_at": _aware(c.created_at),
        })

    # Same pattern for missed_events. Sorted by sent_at so the timeline
    # reflects the actual escalation order even when due_at == sent_at
    # (e.g. a deferred scan run that fires two kinds in one tick).
    alert_rows = (
        db.query(CheckinAlert)
        .filter(CheckinAlert.shift_id.in_(shift_ids))
        .order_by(CheckinAlert.sent_at.asc())
        .all()
    )
    alerts_by_shift: dict[int, list[dict]] = {sid: [] for sid in shift_ids}
    for a in alert_rows:
        alerts_by_shift[a.shift_id].append({
            "id": a.id,
            "kind": a.kind,
            "severity": _alert_severity(a.kind),
            "due_at": _aware(a.due_at),
            "sent_at": _aware(a.sent_at),
            "channel": a.channel,
        })

    # Per-member passive locations: the latest known position of each
    # crew member individually (POST /api/checkins/me/location upserts
    # one row per (shift, user)). Embedded so the map's CrewLayer + the
    # Crew sidebar can place a pin / list a row per worker without
    # making the caller pre-batch this themselves.
    member_loc_rows = (
        db.query(ShiftMemberLocation)
        .filter(ShiftMemberLocation.shift_id.in_(shift_ids))
        .all()
    )
    # Widen the user lookup so member_location names resolve even for
    # users not in lead/crew (defensive: an old crew member who's since
    # been removed but whose passive ping row lingers).
    extra_user_ids = set()
    for m in member_loc_rows:
        if users_by_id is None or m.user_id not in users_by_id:
            extra_user_ids.add(m.user_id)
    if extra_user_ids:
        rows = db.query(User).filter(User.id.in_(extra_user_ids)).all()
        if users_by_id is None:
            users_by_id = {}
        for u in rows:
            users_by_id[u.id] = u
    member_locs_by_shift: dict[int, list[dict]] = {sid: [] for sid in shift_ids}
    for m in member_loc_rows:
        u = (users_by_id or {}).get(m.user_id)
        member_locs_by_shift[m.shift_id].append({
            "user_id": m.user_id,
            "user_name": u.name if u else None,
            "lat": m.lat,
            "lon": m.lon,
            "accuracy_m": float(m.accuracy_m) if m.accuracy_m is not None else None,
            "updated_at": _aware(m.updated_at),
        })

    for s in serialized_shifts:
        s["checkins"] = by_shift.get(s["id"], [])
        s["missed_events"] = alerts_by_shift.get(s["id"], [])
        s["member_locations"] = member_locs_by_shift.get(s["id"], [])


def _users_by_id(db: Session, user_ids: list[int]) -> dict[int, User]:
    """Batch-fetch users keyed by id. Used by the admin endpoints to
    embed names into shift JSON without N+1 queries.
    """
    ids = [uid for uid in {*user_ids} if uid is not None]
    if not ids:
        return {}
    rows = db.query(User).filter(User.id.in_(ids)).filter(User.is_active.is_(True)).all()
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
    # Passive last-known location (foreground reporter). Distinct from the
    # check-in lat/lon -- updated without touching the safety deadline.
    last_loc_lat: Optional[float] = None
    last_loc_lon: Optional[float] = None
    last_loc_accuracy_m: Optional[float] = None
    last_loc_at: Optional[datetime] = None
    # Populated only by the admin History endpoint (passes
    # ``include_events=True`` to ``_serialize_shift``). Empty on
    # active-tab / overview / worker-self responses to keep the
    # payload slim. The History tab expands each shift row into a
    # chronological timeline of its check-ins (each with a map button
    # when GPS was captured) + missed-deadline events from the alert
    # ledger -- gives the office a full audit log per shift.
    checkins: list[CheckinEventRead] = []
    missed_events: list[MissedEventRead] = []
    # Per-member passive locations. Populated by the same embed helper
    # that fills ``checkins`` / ``missed_events`` (admin active +
    # history endpoints). Empty on worker self-serve responses.
    member_locations: list[MemberLocationRead] = []


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


class CheckinEventRead(BaseModel):
    """One check-in event embedded inside ShiftRead.checkins for the
    History tab's expandable timeline.

    Same shape as ``CheckinRead`` plus a resolved ``user_name`` so the
    frontend can render "Joe checked in at 10:42" without a separate
    user lookup. ``recorded_by_name`` is set only on admin force-checkin
    overrides; the timeline uses it to render an explicit "(forced by
    Admin)" suffix.
    """
    model_config = ConfigDict(from_attributes=True)
    id: int
    user_id: int
    user_name: Optional[str] = None
    recorded_by_user_id: Optional[int] = None
    recorded_by_name: Optional[str] = None
    lat: Optional[float] = None
    lon: Optional[float] = None
    accuracy_m: Optional[float] = None
    notes: Optional[str] = None
    created_at: datetime


class MemberLocationRead(BaseModel):
    """One crew member's latest passive location on this shift.

    Embedded in ShiftRead.member_locations for the map's per-member
    pins + the Crew sidebar. ``user_name`` is pre-resolved by the
    embed helper so the frontend doesn't have to do a user lookup.
    """
    model_config = ConfigDict(from_attributes=True)
    user_id: int
    user_name: Optional[str] = None
    lat: Optional[float] = None
    lon: Optional[float] = None
    accuracy_m: Optional[float] = None
    updated_at: Optional[datetime] = None


class MissedEventRead(BaseModel):
    """One missed-deadline / escalation event embedded inside
    ShiftRead.missed_events. Sourced from the ``checkin_alerts`` ledger
    so the timeline shows the same escalations the office actually got
    paged about (T-15, T0, T+3, repeats, office first/urgent).

    ``severity`` is a coarse bucket the frontend uses to colour the
    timeline pill: 'reminder' (T-15), 'due' (T0), 'overdue' (worker
    repeat or office), 'urgent' (office_urgent).
    """
    model_config = ConfigDict(from_attributes=True)
    id: int
    kind: str
    severity: str
    due_at: datetime
    sent_at: datetime
    channel: str


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


class TransferLeadRequest(BaseModel):
    # Hand the crew lead role to one of the existing crew members. The
    # backend swaps shift.user_id with this id and pushes the old lead
    # into crew_user_ids -- no one is dropped from the shift.
    new_lead_user_id: int


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
        and current_user.role not in MANAGES_PINS
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
        and current_user.role not in MANAGES_PINS
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


@me_router.post("/api/shifts/{shift_id}/transfer-lead", response_model=ShiftRead)
def transfer_lead(
    shift_id: int,
    payload: TransferLeadRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ShiftRead:
    """Hand the crew-lead role to another current crew member.

    Use case: the lead leaves the job site mid-shift and someone else
    needs to be the point person for paperwork / be the default-named
    worker on the dashboard. The swap pushes the OLD lead into
    ``crew_user_ids`` so nobody is dropped from the shift, and leaves
    mode + deadline + check-ins untouched (this is a name swap, not a
    composition change). Writes a ShiftChange audit row.

    Authorization: only the current lead may hand off (or an admin/office
    override via MANAGES_PINS). Crew mates can't seize lead from each
    other -- the lead has to initiate.

    New lead MUST be in the existing crew. Picking a stranger would be
    a composition change; use PATCH /api/shifts/{id}/composition for that.
    """
    shift = db.query(Shift).filter(Shift.id == shift_id).first()
    if shift is None:
        raise HTTPException(status_code=404, detail="Shift not found")
    if shift.ended_at is not None:
        raise HTTPException(status_code=400, detail="Cannot edit an ended shift")
    if (
        shift.user_id != current_user.id
        and current_user.role not in MANAGES_PINS
    ):
        raise HTTPException(
            status_code=403,
            detail="Only the current lead can hand off.",
        )

    new_lead_id = payload.new_lead_user_id
    crew_ids = list(shift.crew_user_ids or [])
    if new_lead_id == shift.user_id:
        # No-op: they're already lead.
        return ShiftRead(**_serialize_shift(shift))
    if new_lead_id not in crew_ids:
        raise HTTPException(
            status_code=400,
            detail="New lead must already be in the crew.",
        )
    new_lead_user = db.query(User).filter(User.id == new_lead_id).first()
    if new_lead_user is None:
        raise HTTPException(status_code=404, detail="New lead user not found.")

    old_lead_id = shift.user_id
    old_crew = list(crew_ids)
    # Swap: new lead leaves crew, old lead joins crew. dict.fromkeys
    # preserves order while deduping (defensive: if old_lead was somehow
    # already in crew_ids the result stays clean).
    new_crew = [c for c in crew_ids if c != new_lead_id]
    if old_lead_id not in new_crew:
        new_crew.append(old_lead_id)
    new_crew = list(dict.fromkeys(new_crew))

    shift.user_id = new_lead_id
    shift.crew_user_ids = new_crew

    deadline = _aware(shift.next_deadline_at) or _now()
    change = ShiftChange(
        shift_id=shift.id,
        changed_by_user_id=current_user.id,
        old_mode=shift.mode,
        new_mode=shift.mode,
        old_crew=old_crew,
        new_crew=new_crew,
        old_deadline=deadline,
        new_deadline=deadline,
    )
    db.add(change)
    db.commit()
    db.refresh(shift)

    # Re-serialize with the updated user batch so the embedded
    # user_name / crew_members reflect the new lead.
    user_map = _users_by_id(db, [shift.user_id] + list(shift.crew_user_ids or []))
    return ShiftRead(
        **_serialize_shift(shift, user=user_map.get(shift.user_id), users_by_id=user_map)
    )


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


class LocationPing(BaseModel):
    # A passive GPS sample from the foreground location reporter. lat/lon
    # required; accuracy optional. NOT a safety check-in.
    lat: float
    lon: float
    accuracy_m: Optional[float] = None


@me_router.post("/api/checkins/me/location", response_model=ShiftRead)
def update_my_location(
    payload: LocationPing,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ShiftRead:
    """Record the caller's current device location against their active shift.

    This is a PASSIVE location ping from the foreground reporter (app
    open) — it updates ``shifts.last_loc_*`` only. It DELIBERATELY does
    NOT touch ``last_checkin_at`` or ``next_deadline_at``: a phone
    auto-reporting from a pocket must never satisfy the lone-worker
    safety deadline. Returns 400 when there's no active shift so the
    client can stop pinging.

    Last-writer-wins across a crew (teammates share one truck/shift).
    """
    shift = _get_user_today_shift(db, current_user.id)
    if shift is None:
        raise HTTPException(
            status_code=400,
            detail="No active shift. Start a shift before reporting location.",
        )
    now = _now()
    # Shift-level "truck position" (last-writer-wins across crew).
    shift.last_loc_lat = payload.lat
    shift.last_loc_lon = payload.lon
    shift.last_loc_accuracy_m = payload.accuracy_m
    shift.last_loc_at = now
    # Per-member row so the office can locate each crew member
    # individually -- not just whoever pinged last. Upsert keyed on
    # (shift_id, user_id); the unique index makes this idempotent.
    member = (
        db.query(ShiftMemberLocation)
        .filter(
            ShiftMemberLocation.shift_id == shift.id,
            ShiftMemberLocation.user_id == current_user.id,
        )
        .first()
    )
    if member is None:
        member = ShiftMemberLocation(
            shift_id=shift.id,
            user_id=current_user.id,
        )
        db.add(member)
    member.lat = payload.lat
    member.lon = payload.lon
    member.accuracy_m = payload.accuracy_m
    member.updated_at = now
    db.commit()
    db.refresh(shift)
    return ShiftRead(**_serialize_shift(shift))


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
    you can't crew with yourself.

    The active-user list is sourced from Supabase Auth (the same list
    the User Management panel shows) so users that are soft-deleted in
    Supabase immediately disappear here without depending on the local
    ``is_active`` flag staying in sync.

    The three @pineview.local seed rows (Pineview Admin / Office /
    Worker) are explicitly hidden because they're dev/demo accounts
    that nobody can actually log into in production -- showing them
    in the crew picker just clutters the list with three users that
    can never be selected meaningfully.
    """
    settings = get_settings()
    active_emails: set[str] = set()
    if settings.supabase_url and settings.supabase_service_role_key:
        try:
            client = create_client(settings.supabase_url, settings.supabase_service_role_key)
            result = client.auth.admin.list_users()
            users = result if isinstance(result, list) else (getattr(result, "users", None) or result or [])
            active_emails = {
                u.email.lower()
                for u in users
                if not getattr(u, "deleted_at", None) and u.email
            }
        except Exception:
            # If Supabase Auth is unreachable, fall back to the local is_active
            # flag so the crew picker still works in degraded mode.
            pass

    query = db.query(User).filter(User.id != current_user.id)
    if active_emails:
        query = query.filter(func.lower(User.email).in_(active_emails))
    else:
        # Supabase fallback: trust the local flag.
        query = query.filter(User.is_active.is_(True))
    query = query.filter(~User.email.ilike("%@pineview.local"))
    # Hide the dev account from everyone else's crew picker.
    if not is_dev_email(getattr(current_user, "email", None)):
        query = query.filter(~User.email.ilike(DEV_ACCOUNT_EMAIL))
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
def get_overview(
    db: Session = Depends(get_db),
    include_ended_day: Optional[date] = None,
    current_user: Optional[User] = Depends(get_current_user),
) -> list[OverviewEntry]:
    """Overview tab: anyone with an active shift today OR assigned to an
    active truck. One row per user. Single round-trip.

    When ``include_ended_day`` is set (the Operations TV passes the
    client's local date), shifts that ENDED on that day are also returned
    as ``checked_out`` entries so a worker who tapped "End shift" stays on
    the board (greyed, sorted last) for the rest of the day rather than
    the card vanishing. The admin Overview tab omits the param, so its
    behaviour is unchanged.
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

    # Set 1b (TV only): shifts that ENDED earlier today. Skip users who
    # already have an active shift (a fresh shift supersedes an earlier
    # checkout); keep only the most-recently-ended shift per user.
    ended_shift_by_user: dict[int, Shift] = {}
    if include_ended_day is not None:
        day_start, day_end = _local_day_window(include_ended_day)
        ended_rows = (
            db.query(Shift)
            .filter(
                Shift.ended_at.is_not(None),
                Shift.ended_at >= day_start,
                Shift.ended_at < day_end,
            )
            .all()
        )
        for s in ended_rows:
            if s.user_id in shift_by_user:
                continue
            existing = ended_shift_by_user.get(s.user_id)
            if existing is None or (
                s.ended_at and existing.ended_at and s.ended_at > existing.ended_at
            ):
                ended_shift_by_user[s.user_id] = s

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

    user_ids = (
        set(shift_by_user.keys())
        | set(truck_by_user.keys())
        | set(ended_shift_by_user.keys())
    )
    if not user_ids:
        return []

    # Active shift wins over an earlier ended one for the same user.
    all_shift_by_user: dict[int, Shift] = dict(ended_shift_by_user)
    all_shift_by_user.update(shift_by_user)

    # Widen the user lookup to also include every crew teammate so the
    # serializer can embed their names into ShiftRead.crew_members. A
    # crew teammate doesn't necessarily have their own shift today, so
    # they won't already be in user_ids.
    lookup_ids: set[int] = set(user_ids)
    for sh in all_shift_by_user.values():
        for cid in (sh.crew_user_ids or []):
            lookup_ids.add(cid)

    users = db.query(User).filter(User.id.in_(lookup_ids)).all()
    user_by_id = {u.id: u for u in users}

    # Pre-serialize and batch-embed checkins for every shift so the
    # Overview cards can render today's check-in list (live TV feed).
    shift_serials_by_user: dict[int, dict] = {}
    # Hide the dev account's rows from everyone else (incl. the TV board,
    # which calls this function directly without a current_user).
    hide_dev = not is_dev_email(getattr(current_user, "email", None))
    for uid, sh in all_shift_by_user.items():
        user = user_by_id.get(uid)
        if user is None:
            continue
        if user.email and user.email.lower().endswith("@pineview.local"):
            continue
        if hide_dev and is_dev_email(user.email):
            continue
        shift_serials_by_user[uid] = _serialize_shift(
            sh, user=user, users_by_id=user_by_id
        )
    if shift_serials_by_user:
        _embed_shift_events(
            db, list(shift_serials_by_user.values()), users_by_id=user_by_id
        )

    out: list[OverviewEntry] = []
    for uid in user_ids:
        user = user_by_id.get(uid)
        if user is None:
            continue
        # Demo seed accounts (@pineview.local) shouldn't show on the
        # admin overview either -- nobody can actually log in as them
        # in production, so any shift/truck attached to those rows is
        # noise. Defensive: in normal operation they have neither.
        if user.email and user.email.lower().endswith("@pineview.local"):
            continue
        if hide_dev and is_dev_email(user.email):
            continue
        truck = truck_by_user.get(uid)
        shift_serial = shift_serials_by_user.get(uid)
        # Tier: ended-today shift -> 'checked_out' (greyed, sorted last);
        # live shift -> compliance tier; truck-only -> 'idle'.
        if uid in ended_shift_by_user and uid not in shift_by_user:
            tier_value = "checked_out"
        elif shift_serial:
            tier_value = shift_serial["status_tier"]
        else:
            tier_value = "idle"
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
    rank = {"red": 0, "yellow": 1, "blue": 2, "green": 3, "idle": 4, "off": 5, "checked_out": 6}
    out.sort(key=lambda e: (rank.get(e.status_tier, 9), e.display_name.lower()))
    return out


@admin_router.get("/api/admin/shifts/active", response_model=list[ShiftRead])
def list_active_shifts(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[ShiftRead]:
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
    # Hide the dev account's shifts from everyone else.
    if not is_dev_email(getattr(current_user, "email", None)):
        resolved_rows = [
            s for s in resolved_rows
            if not is_dev_email(getattr(user_map.get(s.user_id), "email", None))
        ]
    serialized = [
        _serialize_shift(s, user=user_map.get(s.user_id), users_by_id=user_map)
        for s in resolved_rows
    ]
    # Embed full check-in list per shift so the dashboard can render
    # today's tap history right on each card (live feed for the office TV).
    _embed_shift_events(db, serialized, users_by_id=user_map)
    return [ShiftRead(**s) for s in serialized]


@admin_router.get("/api/admin/shifts", response_model=list[ShiftRead])
def list_shifts_by_date(
    date_str: Optional[str] = Query(None, alias="date"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[ShiftRead]:
    """History tab: shifts active during the given local-Vancouver date.

    See ``list_active_shifts`` for the user_name embedding rationale.

    Each row also embeds its full ``checkins`` and ``missed_events``
    arrays so the frontend can expand a shift into a chronological
    audit timeline (every "I'm OK" tap with a map link, every T-15 /
    T0 / overdue / office-paged escalation) without any per-row
    follow-up requests.
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
    # Hide the dev account's shifts from everyone else.
    if not is_dev_email(getattr(current_user, "email", None)):
        rows = [
            s for s in rows
            if not is_dev_email(getattr(user_map.get(s.user_id), "email", None))
        ]
    serialized = [
        _serialize_shift(s, user=user_map.get(s.user_id), users_by_id=user_map)
        for s in rows
    ]
    # Attach checkins + missed_events in a single batched roundtrip so
    # expanding any row in the History UI is instant (data already on
    # the client). Mutates the dicts in place.
    _embed_shift_events(db, serialized, users_by_id=user_map)
    return [ShiftRead(**s) for s in serialized]


@admin_router.post(
    "/api/admin/shifts/{shift_id}/end",
    response_model=ShiftRead,
    dependencies=[require_office_admin],
)
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


@admin_router.post(
    "/api/admin/shifts/{shift_id}/checkin",
    response_model=CheckinRead,
    dependencies=[require_office_admin],
)
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
    "/api/admin/checkin-recipients",
    response_model=RecipientRead,
    status_code=201,
    dependencies=[require_office_admin],
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
    "/api/admin/checkin-recipients/{recipient_id}",
    response_model=RecipientRead,
    dependencies=[require_office_admin],
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
    "/api/admin/checkin-recipients/{recipient_id}",
    status_code=204,
    dependencies=[require_office_admin],
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
    dependencies=[require_office_admin],
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
    # The actual ``sub`` claim that will be JWT-signed into each push.
    # Must be a valid mailto: or https: URI per RFC 8292; Apple's Web
    # Push gateway 403s on a malformed sub (e.g. ``mailto:mailto:...``
    # caused by a doubled prefix in VAPID_CONTACT_EMAIL).
    contact_email_raw: Optional[str] = None
    computed_sub_claim: Optional[str] = None
    sub_claim_valid: bool = False


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

    computed_sub = vapid_sub_claim() if contact else ""
    # Valid: exactly one 'mailto:' or 'https:' prefix, then non-empty body.
    sub_valid = False
    if computed_sub:
        lower = computed_sub.lower()
        if lower.startswith("mailto:") and "@" in computed_sub[7:] and not computed_sub[7:].lower().startswith("mailto:"):
            sub_valid = True
        elif lower.startswith("https:") and len(computed_sub) > 8:
            sub_valid = True
    resp = VapidStatusResponse(
        public_key_set=bool(stored_pub),
        private_key_set=bool(priv),
        contact_email_set=bool(contact),
        stored_public_key=stored_pub if stored_pub else None,
        stored_public_length=len(stored_pub),
        contact_email_raw=contact if contact else None,
        computed_sub_claim=computed_sub if computed_sub else None,
        sub_claim_valid=sub_valid,
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


def _run_test_push_for_user(db: Session, user_id: int) -> TestPushResponse:
    """Shared implementation for both the admin diagnostic endpoint and
    the worker-facing "send me a test push" button on the prefs panel.

    Sends a single test notification to every push subscription owned
    by ``user_id`` and returns per-endpoint outcome (success, expired
    + deleted, or failure with status code + truncated response body).
    Same logic as the original admin endpoint; extracted so the worker
    prefs panel can reuse it without duplicating the cleanup + service
    classification code.
    """
    results: list[TestPushEndpointResult] = []
    subs = (
        db.query(PushSubscription)
        .filter(PushSubscription.user_id == user_id)
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
    vapid_claims = {"sub": vapid_sub_claim()}
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
                # Mirror push_service.send_push: ``Urgency: high`` tells
                # Apple/FCM to bypass battery-saver delivery throttling
                # so the test push actually arrives within seconds even
                # on a locked iPhone (Apple Push Service queues normal
                # urgency pushes opportunistically and can delay them
                # tens of minutes -- exactly the symptom the test push
                # is supposed to diagnose).
                headers={"Urgency": "high"},
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


@admin_router.post(
    "/api/admin/checkins/test-push",
    response_model=TestPushResponse,
    dependencies=[require_office_admin],
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
    return _run_test_push_for_user(db, current_user.id)


@me_router.post(
    "/api/checkins/me/test-push", response_model=TestPushResponse
)
def me_test_push(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> TestPushResponse:
    """Worker-facing version of admin_test_push. Lets a worker verify
    that push works on their own phone -- the prefs panel renders a
    "Send me a test push" button that calls this and shows pass/fail.

    Same payload as the admin endpoint; differs only in the auth gate
    (any signed-in user can hit this for their OWN subscriptions).
    Crucial for triaging "I installed the PWA on iOS but never get
    overdue alerts" without waiting for a real shift to go red.
    """
    return _run_test_push_for_user(db, current_user.id)


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
