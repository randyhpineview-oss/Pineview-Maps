"""SQLAlchemy models for the admin/office Calendar feature.

Four standalone tables — no FK back-references to existing models (only forward
FK→users) so this module can be deleted in a rollback without touching the
rest of the schema. Mirrors the audit / soft-delete pattern from
`app.models.Site` and `app.pipeline_models.Pipeline`.
"""
from __future__ import annotations

import enum
from datetime import datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class CalendarTaskPriority(str, enum.Enum):
    important = "important"
    attention = "attention"
    normal = "normal"


class CalendarTask(Base):
    """Daily to-do for the office. Carries forward (re-dated to today)
    automatically every morning until checked off, preserving the original
    scheduled date in ``original_task_date`` for the audit trail."""

    __tablename__ = "calendar_tasks"
    __table_args__ = (
        # Mirrors the CHECK constraint in calendar_setup.sql. Keeps SQLite dev
        # in sync with prod when SQLAlchemy creates the table.
        CheckConstraint(
            "priority IN ('important', 'attention', 'normal')",
            name="ck_calendar_tasks_priority",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    task_date: Mapped[datetime] = mapped_column(Date, nullable=False, index=True)
    # NULL until the first roll-forward; then frozen at the originally
    # chosen date for the rest of the task's life. Lets the UI render a
    # "↻ originally for <date>" badge so an admin can see what's been
    # carrying over for days.
    original_task_date: Mapped[datetime | None] = mapped_column(Date, nullable=True)
    task_text: Mapped[str] = mapped_column(Text, nullable=False)
    priority: Mapped[str] = mapped_column(
        String(16), nullable=False, default=CalendarTaskPriority.normal.value
    )
    assigned_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    assigned_user_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    is_completed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    completed_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    completed_by_name: Mapped[str | None] = mapped_column(String(255), nullable=True)

    # Audit
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
        nullable=False,
        index=True,
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)
    created_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    created_by_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    updated_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    updated_by_name: Mapped[str | None] = mapped_column(String(255), nullable=True)


class CalendarContact(Base):
    """Company / contact directory grouped by client. No date — Contacts are
    always returned in full from the bundle endpoint regardless of the
    calendar view's date range."""

    __tablename__ = "calendar_contacts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    company_name: Mapped[str] = mapped_column(String(255), nullable=False)
    contact_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    phone: Mapped[str | None] = mapped_column(String(64), nullable=True)
    email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    role: Mapped[str | None] = mapped_column(String(120), nullable=True)
    # Free-form, mirrors sites.client value space. No FK — clients are
    # data-driven, not a fixed lookup table.
    client: Mapped[str | None] = mapped_column(String(120), nullable=True, index=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Audit
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
        nullable=False,
        index=True,
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)
    created_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_by_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    updated_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    updated_by_name: Mapped[str | None] = mapped_column(String(255), nullable=True)


class CalendarEvent(Base):
    """Conferences, shows, anything on a date. Supports multi-day events via
    the optional ``end_date`` column."""

    __tablename__ = "calendar_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    event_date: Mapped[datetime] = mapped_column(Date, nullable=False, index=True)
    end_date: Mapped[datetime | None] = mapped_column(Date, nullable=True)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    location: Mapped[str | None] = mapped_column(String(255), nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    url: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Audit
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
        nullable=False,
        index=True,
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)
    created_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    created_by_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    updated_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    updated_by_name: Mapped[str | None] = mapped_column(String(255), nullable=True)


class CalendarBid(Base):
    """Bid posting (manual now; scraper plugs in later). ``closing_date`` is
    NULLABLE because real-world scraper input occasionally has un-parseable
    dates — the UI shows those in a "no close date" bucket above the grid
    rather than dropping them on the floor."""

    __tablename__ = "calendar_bids"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    bid_title: Mapped[str] = mapped_column(String(500), nullable=False)
    closing_date: Mapped[datetime | None] = mapped_column(Date, nullable=True, index=True)
    # 'manual' / 'bcbid' / 'merx' / ... — kept as VARCHAR (not enum) so a new
    # scraper source doesn't need an ALTER TYPE migration.
    source: Mapped[str] = mapped_column(String(64), nullable=False, default="manual")
    source_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    matched_keywords: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    # Source-stable id (e.g. BC Bid posting id) used by the scraper to dedup.
    # NULL for manual rows — the partial UNIQUE in calendar_setup.sql means
    # manual rows don't block each other.
    external_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    is_dismissed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    # Audit
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
        nullable=False,
        index=True,
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)
    created_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_by_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    updated_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    updated_by_name: Mapped[str | None] = mapped_column(String(255), nullable=True)


# Note: the production partial unique
#   UNIQUE (source, external_id) WHERE external_id IS NOT NULL
# is created by calendar_setup.sql, not via SQLAlchemy. SQLite dev doesn't
# enforce it; that's fine because the scraper (the only consumer) only
# runs against the production Postgres.
