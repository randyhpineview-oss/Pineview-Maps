"""SQLAlchemy models for the lone-worker check-in feature.

Seven tables grouped here because they share one domain and depend on
each other through FKs:

  * ``user_profiles``           — per-user notification prefs + last-shift defaults
  * ``shifts``                  — one row per lone-worker shift (alone/crew/off)
  * ``checkins``                — append-only "I'm OK" pings against a shift
  * ``shift_changes``           — audit log of mid-shift mode / crew edits
  * ``push_subscriptions``      — Web Push endpoints (one per worker device)
  * ``checkin_alerts``          — idempotency ledger for the cron scanner
  * ``office_alert_recipients`` — configurable office email list (one primary)

Mirrors the structure of ``app.device_models``: cross-dialect JSON via
``JSON().with_variant(JSONB, 'postgresql')`` so the same models compile
against SQLite (local dev) and Postgres (Supabase). All FKs to
``users.id`` use ON DELETE CASCADE for primary-relationship rows so a
hard-deleted user takes their shift history with them; audit-trail FKs
use ON DELETE SET NULL so the audit row survives the user being purged.

Realtime publication setup lives in ``database/checkins_setup.sql`` —
this module only defines the in-app ORM mapping.
"""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base

# Cross-dialect JSON column type. JSONB on Postgres (binary, indexable),
# JSON on SQLite (stored as TEXT but transparently de/serialised). We
# don't use any JSONB-specific operators against these columns, so the
# SQLite shim is semantically equivalent.
JSONColumn = JSON().with_variant(JSONB(), "postgresql")


class UserProfile(Base):
    """Per-user notification prefs + last-shift defaults.

    Created lazily on first save. The frontend reads this on login to
    pre-populate the StartShift form (last_mode, last_crew_user_ids) and
    to determine which notification channels to dispatch from the cron
    scanner. ``notify_push`` defaults TRUE (primary channel);
    ``notify_email`` defaults FALSE (most workers won't need it).

    Note: ``notify_email_address`` overrides ``users.email`` for
    notification delivery when set. When NULL and ``notify_email=True``,
    the backend falls back to the user's auth email at send time.
    """

    __tablename__ = "user_profiles"

    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
    )
    # 'alone' | 'crew' for next-time defaults in the StartShift form.
    # NULL = no prior shift (cold worker; defaults to 'alone' in UI).
    last_mode: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)
    last_crew_user_ids: Mapped[list] = mapped_column(
        JSONColumn, nullable=False, default=list
    )
    notify_push: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True
    )
    notify_email: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False
    )
    notify_email_address: Mapped[Optional[str]] = mapped_column(
        String(255), nullable=True
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
        nullable=False,
    )


class Shift(Base):
    """A lone-worker shift. ``ended_at`` NULL means active.

    The countdown / overdue scanner / forced overlay all hinge on
    ``next_deadline_at``. It's set on shift start (now + interval per
    mode), bumped on every successful check-in (now + interval), and
    recomputed sooner-only on mid-shift mode changes (never *extended*
    mid-shift — that would let a worker game the deadline).

    ``mode='off'`` is an intentional "I'm not working today" record that
    suppresses the soft morning banner. It still gets a
    ``next_deadline_at`` (far future) so the same active-shift query
    works without special-casing.

    ``device_id`` is auto-linked at start to whichever active device has
    ``assigned_user_id = me``. NULL when zero or >1 device matches; admin
    can fix from the dashboard.

    The lazy auto-end resolver (in checkin_routes.py) sets ``ended_at``
    + ``auto_end_reason`` on any read of an active shift if local
    midnight has passed OR no check-in for ≥14 h.
    """

    __tablename__ = "shifts"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # Auto-linked at start. NULL when zero or >1 active device matches
    # the user's assignment. Admin can fix from the dashboard.
    device_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("devices.id", ondelete="SET NULL"), nullable=True
    )
    # 'alone' (120 min interval), 'crew' (240 min), 'off' (no interval).
    mode: Mapped[str] = mapped_column(String(16), nullable=False)
    crew_user_ids: Mapped[list] = mapped_column(
        JSONColumn, nullable=False, default=list
    )
    crew_freeform: Mapped[str] = mapped_column(
        Text, nullable=False, default=""
    )
    started_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )
    ended_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    ended_by_user_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    # 'midnight' | 'stale_14h' | 'manual' | 'admin_override' | NULL.
    auto_end_reason: Mapped[Optional[str]] = mapped_column(
        String(32), nullable=True
    )
    last_checkin_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime, nullable=True
    )
    # The single source of truth for compliance math. Always populated;
    # for mode='off' rows it's set far in the future as a sentinel.
    next_deadline_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    notes: Mapped[str] = mapped_column(Text, nullable=False, default="")
    # Passive "last known location" for the worker/truck. Updated by the
    # foreground location reporter (POST /api/checkins/me/location) while
    # the app is open. DELIBERATELY separate from check-ins: a passive GPS
    # ping must NOT reset last_checkin_at / next_deadline_at, otherwise a
    # phone pinging from a pocket would falsely satisfy the lone-worker
    # safety deadline. Last-writer-wins across a crew (they share a truck).
    last_loc_lat: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    last_loc_lon: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    last_loc_accuracy_m: Mapped[Optional[float]] = mapped_column(
        Numeric(8, 2), nullable=True
    )
    last_loc_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime, nullable=True
    )

    __table_args__ = (
        CheckConstraint(
            "mode IN ('alone', 'crew', 'off')",
            name="shifts_mode_check",
        ),
    )


class Checkin(Base):
    """Append-only "I'm OK" record against a shift.

    Position is optional (worker may have denied geolocation).
    ``recorded_by_user_id`` is NULL for normal worker-initiated check-ins
    and set to the admin's id ONLY when the admin used the "Force
    check-in" override from the dashboard (rare safety case).
    """

    __tablename__ = "checkins"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, index=True)
    shift_id: Mapped[int] = mapped_column(
        ForeignKey("shifts.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id"), nullable=False, index=True
    )
    recorded_by_user_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    lat: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    lon: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    accuracy_m: Mapped[Optional[float]] = mapped_column(
        Numeric(8, 2), nullable=True
    )
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False, index=True
    )


class ShiftMemberLocation(Base):
    """Latest passive location of ONE member of a shift.

    The shift-level ``shifts.last_loc_*`` is "wherever any member last
    pinged from" (the truck), which is last-writer-wins across a crew.
    This table keeps a per-member row so the office can locate ANY crew
    member individually -- e.g. when the lead is back at the truck doing
    paperwork but a crew mate is out walking the lease. One row per
    (shift, user), upserted by POST /api/checkins/me/location.

    Like ``shifts.last_loc_*`` this is a PASSIVE position: it never
    affects the safety deadline. Rows are scoped to the shift, so they
    vanish with the shift on a hard delete (CASCADE) and stop being
    served once the shift ends (privacy: no off-shift tracking).
    """

    __tablename__ = "shift_member_locations"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, index=True)
    shift_id: Mapped[int] = mapped_column(
        ForeignKey("shifts.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    lat: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    lon: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    accuracy_m: Mapped[Optional[float]] = mapped_column(
        Numeric(8, 2), nullable=True
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    __table_args__ = (
        UniqueConstraint("shift_id", "user_id", name="uq_shift_member_location"),
    )


class ShiftChange(Base):
    """Audit row written every time mid-shift mode or crew is edited.

    Used by the admin History tab to show a timeline within a shift's
    detail expansion. Records both the before- and after-state of the
    fields that matter for compliance:
      * mode       (alone <-> crew flip)
      * crew       (crew_user_ids JSON)
      * deadline   (recomputed sooner-only after a shrink)
    """

    __tablename__ = "shift_changes"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, index=True)
    shift_id: Mapped[int] = mapped_column(
        ForeignKey("shifts.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    changed_by_user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id"), nullable=False
    )
    old_mode: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)
    new_mode: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)
    old_crew: Mapped[Optional[list]] = mapped_column(JSONColumn, nullable=True)
    new_crew: Mapped[Optional[list]] = mapped_column(JSONColumn, nullable=True)
    old_deadline: Mapped[Optional[datetime]] = mapped_column(
        DateTime, nullable=True
    )
    new_deadline: Mapped[Optional[datetime]] = mapped_column(
        DateTime, nullable=True
    )
    changed_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )


class PushSubscription(Base):
    """Web Push subscription endpoint.

    One row per device the worker has subscribed for push notifications.
    ``endpoint`` is the URL Apple/Google/Mozilla gives us; the encrypted
    payload is POSTed there by pywebpush. On 404/410 from the endpoint
    (the user uninstalled the PWA / cleared site data), the row is
    deleted by ``push_service.send_push``.

    p256dh + auth are the application-server keys the browser supplied
    at subscribe time; pywebpush uses them to derive the symmetric
    encryption key for each payload.
    """

    __tablename__ = "push_subscriptions"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    endpoint: Mapped[str] = mapped_column(
        Text, nullable=False, unique=True, index=True
    )
    p256dh: Mapped[str] = mapped_column(Text, nullable=False)
    auth: Mapped[str] = mapped_column(Text, nullable=False)
    user_agent: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )
    last_used_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime, nullable=True
    )


class CheckinAlert(Base):
    """Idempotency ledger for the cron scanner.

    The scanner runs every minute. To avoid double-sending when a run
    is delayed or replayed, every successful send writes a row here
    keyed (shift_id, kind). The scanner checks for an existing row of
    that (shift, kind) before sending; once present, the kind is
    considered "delivered" for that shift forever.

    ``kind`` values:
        worker_t-15               Worker reminder 15 min before deadline
        worker_t0                 Worker reminder at deadline
        worker_overdue_3          Worker urgent at T+3
        worker_overdue_repeat_N   Worker repeats every 10 min after T+3
                                  (N = 10, 20, 30, ... minutes overdue)
        office_first              Office email at T+30 (standard tone)
        office_urgent             Office email at T+60 (urgent tone)

    ``recipient`` is the email address (office) or user id stringified
    (worker push) — kept as text so any channel format fits.
    """

    __tablename__ = "checkin_alerts"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, index=True)
    shift_id: Mapped[int] = mapped_column(
        ForeignKey("shifts.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    kind: Mapped[str] = mapped_column(String(64), nullable=False)
    due_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    sent_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )
    channel: Mapped[str] = mapped_column(String(16), nullable=False)
    recipient: Mapped[str] = mapped_column(Text, nullable=False)
    result: Mapped[str] = mapped_column(
        String(16), nullable=False, default="sent"
    )
    error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    __table_args__ = (
        Index("idx_checkin_alerts_shift_kind", "shift_id", "kind", "due_at"),
    )


class OfficeAlertRecipient(Base):
    """Configurable office email list for overdue alerts.

    Managed from the Settings tab of the Check-ins Dashboard. Exactly
    one row should have ``is_primary=TRUE`` — this is the always-on
    office email and cannot be disabled or deleted via the UI. The
    backend enforces this with 400 responses on PUT/DELETE.

    Partial unique index on is_primary=TRUE (created in
    ``database/checkins_setup.sql``) enforces at-most-one primary at
    the DB level too.
    """

    __tablename__ = "office_alert_recipients"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, index=True)
    email: Mapped[str] = mapped_column(
        String(255), nullable=False, unique=True
    )
    display_name: Mapped[Optional[str]] = mapped_column(
        String(255), nullable=True
    )
    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True
    )
    is_primary: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )

    __table_args__ = (
        CheckConstraint(
            "NOT is_primary OR is_active",
            name="chk_primary_active",
        ),
    )
