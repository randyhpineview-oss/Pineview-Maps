"""FastAPI routes for the OwnTracks-backed truck tracking feature.

Two distinct surfaces:

  1. **Admin CRUD** (``/api/devices``, ``/api/admin/devices``)
     Gated by ``require_roles(admin, office)`` — workers get a 403.
     Office can READ for the map; only admins can create / rotate / delete.

  2. **OwnTracks ingest** (``POST /api/devices/ping``)
     Bearer-token auth (NOT Supabase JWT). The token is matched against
     ``devices.token_hash`` via SHA-256. Returns ``[]`` because OwnTracks
     expects an array (used for waypoints / commands — empty is fine for v1).

The ingest endpoint is the only public-facing route in the system that
doesn't require a JWT, so the auth dance is deliberately minimal: hash
the bearer, look it up indexed, fail closed on miss.
"""
from __future__ import annotations

import hashlib
import logging
import secrets
from datetime import datetime
from typing import Any, Optional

from fastapi import APIRouter, Body, Depends, Header, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.auth import get_current_user, require_roles
from app.database import get_db
from app.device_models import Device, DevicePing
from app.log_util import get_logger
from app.models import RoleEnum, User

logger = get_logger(__name__)


# Two routers so we can register them with different prefixes / auth.
# - read_router: GET /api/devices (admin/office) — list for map render
# - admin_router: /api/admin/devices/* (admin only) — CRUD + token mgmt
# - ingest_router: POST /api/devices/ping — bearer-token auth, OwnTracks
read_router = APIRouter(
    prefix="/api/devices",
    tags=["devices"],
    dependencies=[Depends(require_roles(RoleEnum.admin, RoleEnum.office, RoleEnum.worker))],
)
admin_router = APIRouter(
    prefix="/api/admin/devices",
    tags=["devices-admin"],
    dependencies=[Depends(require_roles(RoleEnum.admin))],
)
ingest_router = APIRouter(prefix="/api/devices", tags=["devices-ingest"])


# ── Helpers ─────────────────────────────────────────────────────────────────


def _hash_token(raw_token: str) -> str:
    """SHA-256 hex of the raw bearer token. Stored at rest; raw value never is."""
    return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()


def _mint_token() -> str:
    """Generate a cryptographically random 32-byte bearer token (URL-safe)."""
    return secrets.token_urlsafe(32)


def _stamp_create(obj: Device, user: User) -> None:
    obj.created_by_user_id = user.id
    obj.created_by_name = user.name
    obj.updated_by_user_id = user.id
    obj.updated_by_name = user.name


def _stamp_update(obj: Device, user: User) -> None:
    obj.updated_by_user_id = user.id
    obj.updated_by_name = user.name


def _resolve_user_name(db: Session, user_id: Optional[int]) -> Optional[str]:
    """Snapshot the assigned user's display name onto the device row.

    Mirrors the pattern in ``calendar_routes._resolve_assigned_user`` —
    returns None if the id is None or the row no longer exists (treat as
    unassigned rather than 400ing the caller; the device still works).
    """
    if user_id is None:
        return None
    u = db.query(User).filter(User.id == user_id).first()
    return u.name if u is not None else None


# ── Pydantic schemas ────────────────────────────────────────────────────────
# Inline here rather than in a separate schemas.py — surface area is small
# enough that a single file is easier to navigate than two.


class DeviceCreate(BaseModel):
    label: str = Field(..., min_length=1, max_length=120)
    color_hex: str = Field(default="#1E88E5", min_length=4, max_length=7)
    assigned_user_id: Optional[int] = None


class DeviceUpdate(BaseModel):
    label: Optional[str] = Field(default=None, min_length=1, max_length=120)
    color_hex: Optional[str] = Field(default=None, min_length=4, max_length=7)
    assigned_user_id: Optional[int] = None
    # Use a sentinel for "unset assigned_user_id" (clear the FK). Pydantic
    # can't distinguish "absent" from "explicit None" in a single Optional
    # field, so we expose ``clear_assigned_user`` as an explicit toggle.
    clear_assigned_user: bool = False
    is_active: Optional[bool] = None


class DeviceRead(BaseModel):
    """Map + admin list response. Token hash is intentionally omitted."""

    id: int
    label: str
    color_hex: str
    assigned_user_id: Optional[int]
    assigned_user_name: Optional[str]
    last_lat: Optional[float]
    last_lng: Optional[float]
    last_seen_at: Optional[datetime]
    last_battery_pct: Optional[int]
    last_speed_kph: Optional[float]
    last_accuracy_m: Optional[float]
    is_active: bool
    token_rotated_at: datetime
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class DeviceCreatedResponse(BaseModel):
    """Returned ONCE at create or rotate. ``raw_token`` is shown to the admin
    on screen for paste-into-OwnTracks and is never retrievable again."""

    device: DeviceRead
    raw_token: str


class TokenRotateResponse(BaseModel):
    device_id: int
    raw_token: str
    token_rotated_at: datetime


class AssignableUser(BaseModel):
    """Slim user row for the DeviceAdmin "assigned employee" dropdown.

    Returns the LOCAL ``users.id`` (integer) so the device row's FK can
    point at it directly. We can't use the frontend's ``cachedUsers``
    array for this because that's a Supabase-admin-API + Realtime hybrid
    where some rows carry UUID string ids (from /api/admin/users) and
    others carry int ids (from the local users-table Realtime stream).
    """

    id: int
    name: str
    email: str

    model_config = {"from_attributes": True}


# ── Admin: list / create / update / rotate / delete ─────────────────────────


@read_router.get("", response_model=list[DeviceRead])
def list_devices(
    include_inactive: bool = False,
    db: Session = Depends(get_db),
) -> list[DeviceRead]:
    """Map render + admin list. Workers see only active devices (no
    inactive bleed-through); admins can pass ``include_inactive=true`` to
    see retired iPads in the admin tab."""
    q = db.query(Device)
    if not include_inactive:
        q = q.filter(Device.is_active.is_(True))
    rows = q.order_by(Device.label.asc()).all()
    return [DeviceRead.model_validate(r) for r in rows]


@admin_router.get("/assignable-users", response_model=list[AssignableUser])
def list_assignable_users(db: Session = Depends(get_db)) -> list[AssignableUser]:
    """Local users available for the "assigned employee" dropdown in
    DeviceAdmin. Returns integer IDs that can be sent back as
    ``assigned_user_id`` on create / update.

    Returns every user regardless of role — admins / office / workers
    can all be assigned to a truck (e.g., an office staffer sometimes
    drives in the field). Sorted by name for stable dropdown ordering.
    """
    rows = db.query(User).order_by(User.name.asc()).all()
    return [AssignableUser.model_validate(u) for u in rows]


@admin_router.post(
    "",
    response_model=DeviceCreatedResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_device(
    payload: DeviceCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> DeviceCreatedResponse:
    """Register a new iPad. Generates the bearer token server-side and
    returns the RAW value exactly once — admin must paste it into OwnTracks
    immediately. After this response, only the SHA-256 hash exists in the DB."""
    raw_token = _mint_token()
    token_hash = _hash_token(raw_token)

    # Snapshot the assigned user's name so the map tooltip stays correct
    # even if the user row is later renamed or deleted.
    assigned_name = _resolve_user_name(db, payload.assigned_user_id)

    device = Device(
        label=payload.label.strip(),
        color_hex=payload.color_hex,
        assigned_user_id=payload.assigned_user_id,
        assigned_user_name=assigned_name,
        token_hash=token_hash,
        token_rotated_at=datetime.utcnow(),
    )
    _stamp_create(device, current_user)
    db.add(device)
    db.commit()
    db.refresh(device)
    logger.info("Device created id=%s label=%s by user=%s", device.id, device.label, current_user.id)
    return DeviceCreatedResponse(
        device=DeviceRead.model_validate(device),
        raw_token=raw_token,
    )


@admin_router.patch("/{device_id}", response_model=DeviceRead)
def update_device(
    device_id: int,
    payload: DeviceUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> DeviceRead:
    """Edit label / color / assignment / active flag. Returns the updated
    row WITHOUT the token (token mutations go through ``/rotate-token``)."""
    device = db.query(Device).filter(Device.id == device_id).first()
    if device is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Device not found")

    if payload.label is not None:
        device.label = payload.label.strip()
    if payload.color_hex is not None:
        device.color_hex = payload.color_hex
    if payload.clear_assigned_user:
        # Explicit clear path — Pydantic can't distinguish "not sent" from
        # "sent as None" otherwise. See DeviceUpdate.clear_assigned_user.
        device.assigned_user_id = None
        device.assigned_user_name = None
    elif payload.assigned_user_id is not None:
        device.assigned_user_id = payload.assigned_user_id
        device.assigned_user_name = _resolve_user_name(db, payload.assigned_user_id)
    if payload.is_active is not None:
        device.is_active = payload.is_active

    _stamp_update(device, current_user)
    db.commit()
    db.refresh(device)
    return DeviceRead.model_validate(device)


@admin_router.post("/{device_id}/rotate-token", response_model=TokenRotateResponse)
def rotate_device_token(
    device_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> TokenRotateResponse:
    """Generate a new bearer token, invalidating the old one. Used when
    a device is reassigned or a token may have leaked. Returns the raw
    value ONCE — same pattern as create_device."""
    device = db.query(Device).filter(Device.id == device_id).first()
    if device is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Device not found")

    raw_token = _mint_token()
    device.token_hash = _hash_token(raw_token)
    device.token_rotated_at = datetime.utcnow()
    _stamp_update(device, current_user)
    db.commit()
    db.refresh(device)
    logger.info("Device token rotated id=%s by user=%s", device.id, current_user.id)
    return TokenRotateResponse(
        device_id=device.id,
        raw_token=raw_token,
        token_rotated_at=device.token_rotated_at,
    )


@admin_router.delete("/{device_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_device(
    device_id: int,
    hard: bool = False,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Soft-disable by default (sets ``is_active=False``); pass ``hard=true``
    to actually drop the row. Soft is the safe default — keeps the audit
    trail and lets admins reactivate without re-pairing OwnTracks.

    No ``-> None`` return annotation on purpose: FastAPI 0.116+ would
    interpret it as a declared empty response body, which trips the
    framework's "204 must not have a response body" assertion at startup."""
    device = db.query(Device).filter(Device.id == device_id).first()
    if device is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Device not found")
    if hard:
        # CASCADE on device_pings.device_id handles the history rows.
        db.delete(device)
        logger.info("Device hard-deleted id=%s by user=%s", device_id, current_user.id)
    else:
        device.is_active = False
        _stamp_update(device, current_user)
        logger.info("Device soft-disabled id=%s by user=%s", device_id, current_user.id)
    db.commit()


# ── OwnTracks ingest ────────────────────────────────────────────────────────


def _authenticate_device(
    authorization: Optional[str],
    db: Session,
) -> Device:
    """Verify the OwnTracks Authorization: Bearer <token> header and return
    the Device row. Fails closed (401) on any error so a leaked or stale
    token can't dump pings into the system."""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or malformed Authorization header",
        )
    raw_token = authorization.split(" ", 1)[1].strip()
    if not raw_token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Empty bearer token",
        )
    token_hash = _hash_token(raw_token)
    device = (
        db.query(Device)
        .filter(Device.token_hash == token_hash, Device.is_active.is_(True))
        .first()
    )
    if device is None:
        # Don't leak whether the token format was valid vs. the device was
        # disabled vs. nothing matches — just 401.
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid device token",
        )
    return device


def _parse_owntracks_timestamp(tst: Any) -> datetime:
    """OwnTracks ships ``tst`` as a unix second integer. Tolerate strings
    and missing values by falling back to "now" so a malformed payload
    still creates an ingestable row instead of 400ing the device."""
    try:
        if tst is None:
            return datetime.utcnow()
        # Both 1.7.x (int seconds) and some older clients (str) get coerced
        # the same way.
        return datetime.utcfromtimestamp(int(float(tst)))
    except (TypeError, ValueError, OverflowError, OSError):
        return datetime.utcnow()


@ingest_router.post("/ping")
def ingest_ping(
    payload: dict[str, Any] = Body(...),
    authorization: Optional[str] = Header(default=None),
    db: Session = Depends(get_db),
):
    """OwnTracks HTTP-mode endpoint.

    Auth: ``Authorization: Bearer <device_token>`` (configured in OwnTracks
    Settings → HTTP → Authentication). The token is matched against
    ``devices.token_hash``; failure returns 401 closed.

    Payload: OwnTracks emits a single JSON object with ``_type``,
    ``lat``, ``lon``, ``tst`` (unix seconds), ``batt`` (0-100, optional),
    ``vel`` (m/s, optional), ``acc`` (meters, optional), and others.

    We only persist ``_type == 'location'`` records. Other types
    (``waypoints``, ``transition``, ``cmd``) are accepted (return ``[]``)
    so the OwnTracks client doesn't keep retrying them, but we don't
    write a row — those are noise for v1.

    Returns ``[]`` because OwnTracks expects an array response (used to
    push waypoints / commands back to the device). Empty is fine.
    """
    device = _authenticate_device(authorization, db)

    payload_type = (payload.get("_type") or "").strip().lower()
    if payload_type != "location":
        # Acknowledge but don't persist — OwnTracks will retry otherwise.
        return []

    try:
        lat = float(payload["lat"])
        lng = float(payload["lon"])
    except (KeyError, TypeError, ValueError):
        # Malformed location — log and 400. OwnTracks marks the payload
        # as failed and retries later, which is the right behaviour
        # (occasional GPS-not-yet-fixed payloads will eventually succeed).
        logger.warning(
            "Device %s sent malformed location payload (no lat/lon)",
            device.id,
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Missing lat/lon",
        )

    recorded_at = _parse_owntracks_timestamp(payload.get("tst"))

    # Pull optional fields. OwnTracks ``vel`` is m/s; we store km/h
    # because that's what the map tooltip / dashboard displays directly.
    batt = payload.get("batt")
    if batt is not None:
        try:
            batt = int(batt)
        except (TypeError, ValueError):
            batt = None

    vel_mps = payload.get("vel")
    speed_kph: Optional[float] = None
    if vel_mps is not None:
        try:
            speed_kph = float(vel_mps) * 3.6
        except (TypeError, ValueError):
            speed_kph = None

    acc = payload.get("acc")
    if acc is not None:
        try:
            acc = float(acc)
        except (TypeError, ValueError):
            acc = None

    # Insert the history row.
    ping = DevicePing(
        device_id=device.id,
        lat=lat,
        lng=lng,
        recorded_at=recorded_at,
        battery_pct=batt,
        speed_kph=speed_kph,
        accuracy_m=acc,
        raw=payload,
    )
    db.add(ping)

    # Update the denormalized last-known snapshot only if this ping is
    # newer than what we already have. Out-of-order pings (OwnTracks
    # queues offline payloads and may flush them in non-monotonic order)
    # shouldn't move the map pin BACKWARDS in time.
    if device.last_seen_at is None or recorded_at > device.last_seen_at:
        device.last_lat = lat
        device.last_lng = lng
        device.last_seen_at = recorded_at
        device.last_battery_pct = batt
        device.last_speed_kph = speed_kph
        device.last_accuracy_m = acc
        device.last_payload = payload

    db.commit()
    return []
