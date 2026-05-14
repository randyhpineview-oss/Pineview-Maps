"""SQLAlchemy models for the OwnTracks-backed truck tracking feature.

Two standalone tables:
  * ``devices``       — one row per registered iPad (label, color, token,
                        last-known position snapshot for fast map render)
  * ``device_pings``  — append-only history of every OwnTracks ping
                        (used for breadcrumb playback / debugging)

No FK back-references into existing models (only a forward FK to ``users``)
so this module can be removed in a rollback without touching the rest of
the schema. Mirrors the audit / soft-delete pattern from
``app.models.Site`` and ``app.calendar_models.CalendarTask``.

Important: the OwnTracks ``POST /api/devices/ping`` endpoint authenticates
via the device's bearer token, NOT via the Supabase JWT, so it is the one
public-ish endpoint in the system. The token is stored as a SHA-256 hash
(``token_hash``) — the raw value is only shown once to the admin at create
or rotate time so we can never expose it later.
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    Numeric,
    String,
    Text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base

# Cross-dialect JSON column type. Renders as JSONB in Postgres (binary
# storage + indexable operators) and as JSON in SQLite (stored as TEXT,
# but readable/writable via SQLAlchemy's standard JSON type). We don't
# use any JSONB-specific operators (?, @>, etc.) on these columns —
# they're treated as opaque payloads — so the SQLite shim is fully
# semantically equivalent at the app layer.
JSONColumn = JSON().with_variant(JSONB(), "postgresql")


class Device(Base):
    """A registered iPad/phone that reports its position via OwnTracks.

    The truck pin on the map uses ``color_hex`` directly — there is NO
    fallback to the assigned user's color. ``assigned_user_id`` is purely
    a label shown in the tooltip ("Truck 5 · Randy") and does not affect
    rendering.
    """

    __tablename__ = "devices"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    # Human-readable name shown on the map tooltip and admin list.
    # Free-form so admins can use whatever convention fits ("Truck 5",
    # "Red F-150", "Sprayer Rig 2").
    label: Mapped[str] = mapped_column(String(120), nullable=False)
    # Required at creation. Defaults to the next unused preset color
    # picked client-side (see DeviceAdmin.jsx). Stored as #RRGGBB so the
    # map can paint the pin without a lookup table.
    color_hex: Mapped[str] = mapped_column(String(7), nullable=False, default="#1E88E5")
    # Tooltip label only — does NOT influence pin color. Worker rotation
    # between trucks is handled by editing this field, not by any kind
    # of session-claim or daily assignment.
    assigned_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    # Denormalized snapshot — survives an admin renaming the user row
    # without rewriting every device's tooltip. Same pattern as
    # ``site_spray_records.sprayed_by_name``.
    assigned_user_name: Mapped[str | None] = mapped_column(String(255), nullable=True)

    # ── Auth ────────────────────────────────────────────────────────────
    # SHA-256 hex of the raw bearer token. The raw value is shown to the
    # admin ONCE (right after create / rotate) so they can configure it
    # in OwnTracks; after that, only the hash exists. Brute-forcing a
    # SHA-256 of a 32-byte random token is computationally infeasible,
    # so this is fine even without bcrypt's cost factor.
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True, index=True)
    token_rotated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )

    # ── Last-known position snapshot ────────────────────────────────────
    # Denormalized from device_pings so the map list endpoint is a single
    # row read per truck instead of an N+1 sub-query. Nullable until the
    # very first ping lands.
    last_lat: Mapped[float | None] = mapped_column(Float, nullable=True)
    last_lng: Mapped[float | None] = mapped_column(Float, nullable=True)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)
    # Battery percent reported by OwnTracks (0-100). NULL on iOS when the
    # user hasn't granted battery access (uncommon).
    last_battery_pct: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # Speed in km/h (OwnTracks reports m/s; converted on ingest).
    last_speed_kph: Mapped[float | None] = mapped_column(Numeric(7, 2), nullable=True)
    # GPS horizontal accuracy in meters. Useful for debugging "why is
    # the pin jumping" reports.
    last_accuracy_m: Mapped[float | None] = mapped_column(Numeric(8, 2), nullable=True)
    # Raw last payload as received — kept for debugging anomalous reports.
    # Never read by the read path; existence helps when a worker says
    # "my pin is wrong" and we need to see what OwnTracks actually sent.
    last_payload: Mapped[dict | None] = mapped_column(JSONColumn, nullable=True)

    # ── Soft-disable + audit ────────────────────────────────────────────
    # Setting is_active=False hides the device from the map and admin
    # list but keeps the row + all historical pings (regulatory trail).
    # Hard delete is supported via a separate admin action.
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
        nullable=False,
        index=True,
    )
    created_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_by_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    updated_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    updated_by_name: Mapped[str | None] = mapped_column(String(255), nullable=True)


class DevicePing(Base):
    """Append-only history of every OwnTracks ping a device has sent.

    Used by Phase 4 (breadcrumb playback) and as the audit trail for the
    last-known position on the parent ``devices`` row. The ingest path is
    intentionally cheap: insert one row, update one denormalized snapshot.

    Auto-pruned to the last 30 days by a daily job (TODO Phase 4).
    """

    __tablename__ = "device_pings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    device_id: Mapped[int] = mapped_column(
        ForeignKey("devices.id", ondelete="CASCADE"), nullable=False, index=True
    )
    lat: Mapped[float] = mapped_column(Float, nullable=False)
    lng: Mapped[float] = mapped_column(Float, nullable=False)
    # OwnTracks ``tst`` claim (unix seconds, integer) interpreted as UTC.
    # We trust this over server-arrival time because Starlink + iPad time
    # is solid and the device may queue pings while disconnected.
    recorded_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)
    battery_pct: Mapped[int | None] = mapped_column(Integer, nullable=True)
    speed_kph: Mapped[float | None] = mapped_column(Numeric(7, 2), nullable=True)
    accuracy_m: Mapped[float | None] = mapped_column(Numeric(8, 2), nullable=True)
    # Raw OwnTracks JSON payload (already-parsed by FastAPI). Kept so a
    # field-report bug ("pin is 500m off") can be reproduced exactly.
    raw: Mapped[dict | None] = mapped_column(JSONColumn, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
