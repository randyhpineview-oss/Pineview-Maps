from __future__ import annotations

import enum
import secrets
import string
from datetime import datetime, timedelta

from sqlalchemy import CheckConstraint, Date, DateTime, Enum, Float, ForeignKey, Integer, Numeric, String, Text, Boolean, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class TMTicketStatus(str, enum.Enum):
    open = "open"
    submitted = "submitted"
    approved = "approved"


class RoleEnum(str, enum.Enum):
    admin = "admin"
    office = "office"
    crew_lead = "crew_lead"
    worker = "worker"


class SiteStatus(str, enum.Enum):
    not_inspected = "not_inspected"
    in_progress = "in_progress"
    inspected = "inspected"
    issue = "issue"
    issue_not_inspected = "issue_not_inspected"


class ApprovalState(str, enum.Enum):
    approved = "approved"
    pending_review = "pending_review"
    rejected = "rejected"


class PinType(str, enum.Enum):
    lsd = "lsd"
    water = "water"
    quad_access = "quad_access"
    reclaimed = "reclaimed"


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    email: Mapped[str] = mapped_column(String(255), nullable=False, unique=True, index=True)
    role: Mapped[RoleEnum] = mapped_column(Enum(RoleEnum), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)

    created_sites: Mapped[list["Site"]] = relationship(
        back_populates="created_by_user",
        foreign_keys="Site.created_by_user_id",
    )
    approved_sites: Mapped[list["Site"]] = relationship(
        back_populates="approved_by_user",
        foreign_keys="Site.approved_by_user_id",
    )
    updates: Mapped[list["SiteUpdate"]] = relationship(back_populates="created_by_user")


class Site(Base):
    __tablename__ = "sites"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    pin_type: Mapped[PinType] = mapped_column(Enum(PinType), nullable=False, default=PinType.lsd)
    lsd: Mapped[str | None] = mapped_column(String(120), nullable=True)
    client: Mapped[str | None] = mapped_column(String(120), nullable=True, index=True)
    area: Mapped[str | None] = mapped_column(String(120), nullable=True, index=True)
    latitude: Mapped[float] = mapped_column(Float, nullable=False)
    longitude: Mapped[float] = mapped_column(Float, nullable=False)
    status: Mapped[SiteStatus] = mapped_column(Enum(SiteStatus), nullable=False, default=SiteStatus.not_inspected)
    approval_state: Mapped[ApprovalState] = mapped_column(
        Enum(ApprovalState),
        nullable=False,
        default=ApprovalState.approved,
        index=True,
    )
    gate_code: Mapped[str | None] = mapped_column(String(120), nullable=True)
    phone_number: Mapped[str | None] = mapped_column(String(255), nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    source: Mapped[str] = mapped_column(String(64), nullable=False, default="field_added")
    source_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    raw_attributes: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    last_inspected_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_inspected_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    last_inspected_by_email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    last_inspected_by_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
        nullable=False,
    )
    created_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    # Denormalized name so Supabase Realtime payloads (which ship the raw
    # row, no JOINs) can render the requester immediately on the admin's
    # pending-approvals card. Mirrors the last_inspected_by_name pattern.
    created_by_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    approved_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    pending_pin_type: Mapped[PinType | None] = mapped_column(Enum(PinType), nullable=True)
    pending_change_requested_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    pending_change_requested_by_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    deleted_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    is_hidden: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, index=True)

    spray_records: Mapped[list["SiteSprayRecord"]] = relationship(
        back_populates="site",
        cascade="all, delete-orphan",
        order_by="desc(SiteSprayRecord.created_at)",
    )

    created_by_user: Mapped[User | None] = relationship(
        back_populates="created_sites",
        foreign_keys=[created_by_user_id],
    )
    approved_by_user: Mapped[User | None] = relationship(
        back_populates="approved_sites",
        foreign_keys=[approved_by_user_id],
    )
    last_inspected_by_user: Mapped[User | None] = relationship(
        foreign_keys=[last_inspected_by_user_id],
    )
    pending_change_requested_by_user: Mapped[User | None] = relationship(
        foreign_keys=[pending_change_requested_by_user_id],
    )
    updates: Mapped[list["SiteUpdate"]] = relationship(
        back_populates="site",
        cascade="all, delete-orphan",
        order_by="desc(SiteUpdate.created_at)",
    )


class SiteUpdate(Base):
    __tablename__ = "site_updates"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    site_id: Mapped[int] = mapped_column(ForeignKey("sites.id"), nullable=False, index=True)
    status: Mapped[SiteStatus] = mapped_column(Enum(SiteStatus), nullable=False)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    sync_status: Mapped[str] = mapped_column(String(32), nullable=False, default="synced")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    created_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)

    site: Mapped[Site] = relationship(back_populates="updates")
    created_by_user: Mapped[User | None] = relationship(back_populates="updates")


class SiteSprayRecord(Base):
    __tablename__ = "site_spray_records"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    site_id: Mapped[int] = mapped_column(ForeignKey("sites.id"), nullable=False, index=True)
    spray_date: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    sprayed_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    sprayed_by_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_avoided: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
        nullable=False,
        index=True,
    )
    ticket_number: Mapped[str | None] = mapped_column(String(50), nullable=True, index=True)
    lease_sheet_data: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    pdf_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    photo_urls: Mapped[list | None] = mapped_column(JSONB, nullable=True, default=list)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)
    deleted_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    tm_ticket_id: Mapped[int | None] = mapped_column(
        ForeignKey("time_materials_tickets.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    # Idempotency key for offline-submitted lease sheets. The frontend
    # generates a UUID before queueing the upload; if a retry posts the same
    # ID, the backend returns the existing record instead of creating a
    # duplicate. Prevents double-burning a ticket number when the network
    # drops *after* the server processed the request but before the client
    # got the 200. Nullable for legacy rows (pre-migration); enforced via a
    # partial unique index in _migrate_add_columns().
    #
    # No `index=True` here on purpose: the partial unique index
    # (`uq_site_spray_records_client_submission_id`) created in
    # _migrate_add_columns() already covers every equality lookup we do
    # against this column. A second plain index on the same column would
    # be dead weight on writes. The redundant `ix_site_spray_records_*`
    # index that earlier deploys created via `index=True` is dropped on
    # startup by the same migration block.
    client_submission_id: Mapped[str | None] = mapped_column(String(64), nullable=True)

    site: Mapped[Site] = relationship(back_populates="spray_records")
    tm_ticket: Mapped["TimeMaterialsTicket | None"] = relationship(
        back_populates="spray_records",
        foreign_keys=[tm_ticket_id],
    )
    # A spray record can generate multiple T&M rows — one "main" row for the
    # site (Wellsite/Water/etc.) plus an optional "Roadside" companion row
    # when the lease sheet includes access-road activity. Uniqueness is
    # enforced by the (spray_record_id, site_type) composite constraint on
    # TimeMaterialsRow, so there's at most one per site_type.
    tm_rows: Mapped[list["TimeMaterialsRow"]] = relationship(
        back_populates="spray_record",
        cascade="all, delete-orphan",
    )


class TimeMaterialsTicket(Base):
    """Time & Materials billing ticket. Accumulates rows from linked SiteSprayRecords."""
    __tablename__ = "time_materials_tickets"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    ticket_number: Mapped[str] = mapped_column(String(50), nullable=False, unique=True, index=True)
    spray_date: Mapped[datetime] = mapped_column(Date, nullable=False, index=True)
    client: Mapped[str] = mapped_column(String(120), nullable=False, index=True)
    area: Mapped[str] = mapped_column(String(120), nullable=False, index=True)
    description_of_work: Mapped[str | None] = mapped_column(Text, nullable=True)
    po_approval_number: Mapped[str | None] = mapped_column(String(120), nullable=True)
    created_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True, index=True)
    created_by_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
        nullable=False,
        index=True,
    )
    pdf_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Free-form office pricing: { lines: [{ label, qty, rate }, ...], gst_percent: 5 }
    office_data: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    approved_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    approved_by_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    approved_signature: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[TMTicketStatus] = mapped_column(
        Enum(TMTicketStatus),
        nullable=False,
        default=TMTicketStatus.open,
        index=True,
    )
    # Soft-delete so the /delta endpoint can ship removed IDs to the frontend
    # cache in `ids_removed`, mirroring the sites/pipelines pattern. A
    # hard-deleted row would never appear in a delta and stale client caches
    # would keep showing the ticket until the next full refresh.
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)

    rows: Mapped[list["TimeMaterialsRow"]] = relationship(
        back_populates="ticket",
        cascade="all, delete-orphan",
        order_by="TimeMaterialsRow.created_at",
    )
    spray_records: Mapped[list["SiteSprayRecord"]] = relationship(
        back_populates="tm_ticket",
        foreign_keys=[SiteSprayRecord.tm_ticket_id],
    )
    # Pipeline-side link. Uses a string-keyed foreign_keys clause so this
    # model file doesn't need to import pipeline_models (avoids a circular
    # import with app.pipeline_models, which imports from app.database).
    pipeline_spray_records: Mapped[list["pipeline_models.SprayRecord"]] = relationship(
        "SprayRecord",
        back_populates="tm_ticket",
        foreign_keys="SprayRecord.tm_ticket_id",
    )


class TimeMaterialsRow(Base):
    """A single 'Sites Treated' row on a T&M ticket, sourced from a linked lease sheet.

    A lease sheet may generate multiple rows on the same ticket — typically one
    main row (Wellsite / Water / Quad Access / Reclaimed) plus an optional
    companion 'Roadside' row when the sheet has access-road activity. So the
    uniqueness contract is COMPOSITE: per (spray_record_id, site_type), not
    per spray_record_id alone. See tm_rows_composite_unique_migration.sql.
    """
    __tablename__ = "time_materials_rows"
    __table_args__ = (
        UniqueConstraint("spray_record_id", "site_type", name="uq_tm_rows_spray_site_type"),
        UniqueConstraint(
            "pipeline_spray_record_id", "site_type",
            name="uq_tm_rows_pipeline_spray_site_type",
        ),
        # Exactly one of the two spray-record FKs must be set. Site-sourced
        # rows point at site_spray_records; pipeline-sourced rows point at
        # spray_records (the pipeline table). Enforced in DB so no code path
        # can accidentally orphan a row or link it to both sides.
        CheckConstraint(
            "(spray_record_id IS NOT NULL) <> (pipeline_spray_record_id IS NOT NULL)",
            name="ck_tm_rows_exactly_one_spray_fk",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    ticket_id: Mapped[int] = mapped_column(
        ForeignKey("time_materials_tickets.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    spray_record_id: Mapped[int | None] = mapped_column(
        ForeignKey("site_spray_records.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )
    pipeline_spray_record_id: Mapped[int | None] = mapped_column(
        ForeignKey("spray_records.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )
    location: Mapped[str | None] = mapped_column(String(255), nullable=True)
    site_type: Mapped[str | None] = mapped_column(String(64), nullable=True)
    herbicides: Mapped[str | None] = mapped_column(String(255), nullable=True)
    liters_used: Mapped[float | None] = mapped_column(Numeric(12, 2), nullable=True)
    area_ha: Mapped[float | None] = mapped_column(Numeric(12, 2), nullable=True)
    cost_code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)

    ticket: Mapped[TimeMaterialsTicket] = relationship(back_populates="rows")
    spray_record: Mapped[SiteSprayRecord | None] = relationship(
        back_populates="tm_rows",
        foreign_keys=[spray_record_id],
    )
    pipeline_spray_record: Mapped["pipeline_models.SprayRecord | None"] = relationship(
        "SprayRecord",
        back_populates="tm_rows",
        foreign_keys=[pipeline_spray_record_id],
    )


class QuoteRateCategory(Base):
    """A category in the Quote Builder rate catalog (e.g., Hydroseeding,
    Herbicide Application, Drone Mapping, Drone Seeding).

    Edited only via the Settings tab inside the Quote Builder overlay — NOT
    via the existing Lookup Tables panel. Schema mirrors the existing lookup
    tables (id, name, sort_order, is_active, timestamps).
    """
    __tablename__ = "quote_rate_categories"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False, unique=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0, index=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
        nullable=False,
    )

    items: Mapped[list["QuoteRateItem"]] = relationship(
        back_populates="category",
        cascade="all, delete-orphan",
        order_by="QuoteRateItem.sort_order",
    )


class QuoteRateItem(Base):
    """A single line-item rate inside a category. Each row is one priced
    entry the user can pick when assembling a quote (e.g. "T400 Hydroseeder"
    at $425/hr, "Seed (per bag)" at $750/22.8 kg bag).

    `default_markup_pct` is NULL for normal items. When set (e.g., 10.0 for
    "Seed (sourced at cost)"), the quote builder renders an inline
    "+X% (label)" checkbox on the line and adds the markup to the subtotal
    via `qty × rate × (1 + pct/100)`.
    """
    __tablename__ = "quote_rate_items"
    __table_args__ = (
        UniqueConstraint("category_id", "name", name="uq_quote_rate_items_category_name"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    category_id: Mapped[int] = mapped_column(
        ForeignKey("quote_rate_categories.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    unit: Mapped[str] = mapped_column(String(60), nullable=False, default="")
    rate: Mapped[float] = mapped_column(Numeric(12, 4), nullable=False, default=0)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    default_markup_pct: Mapped[float | None] = mapped_column(Numeric(6, 2), nullable=True)
    default_markup_label: Mapped[str | None] = mapped_column(String(60), nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
        nullable=False,
    )

    category: Mapped[QuoteRateCategory] = relationship(back_populates="items")


class Quote(Base):
    """A submitted quote. The full line-item array is kept as JSONB
    (`line_items_json`) so we don't need a separate quote_lines table — the
    catalog can drift after submission without breaking historical quotes.

    Soft-delete via `deleted_at` matches the spray-records / TM-ticket
    pattern so AdminPanel → Recent Deletes can surface restorable rows.
    """
    __tablename__ = "quotes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    quote_number: Mapped[str] = mapped_column(String(20), nullable=False, unique=True, index=True)
    client: Mapped[str] = mapped_column(String(120), nullable=False, index=True)
    area: Mapped[str | None] = mapped_column(String(120), nullable=True)
    project_description: Mapped[str | None] = mapped_column(Text, nullable=True)
    quote_date: Mapped[datetime] = mapped_column(Date, nullable=False, index=True)
    mix_categories: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    tax_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    tax_label: Mapped[str | None] = mapped_column(String(60), nullable=True)
    tax_rate: Mapped[float | None] = mapped_column(Numeric(6, 3), nullable=True)
    subtotal: Mapped[float] = mapped_column(Numeric(14, 2), nullable=False, default=0)
    tax_amount: Mapped[float] = mapped_column(Numeric(14, 2), nullable=False, default=0)
    grand_total: Mapped[float] = mapped_column(Numeric(14, 2), nullable=False, default=0)
    line_items_json: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    pdf_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True, index=True)
    created_by_email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_by_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
        nullable=False,
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)
    deleted_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)


class HydroseedTicket(Base):
    """Hydroseed billing ticket (HT######). Mirrors `TimeMaterialsTicket` —
    many `HydroseedDailyRecord` rows roll up into one HT; office prices it
    by filling `office_data` (worker-fills-qty / office-fills-rate pattern),
    signs, and approves. Soft-delete via `deleted_at` for delta sync.
    """
    __tablename__ = "hydroseed_tickets"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    ticket_number: Mapped[str] = mapped_column(String(50), nullable=False, unique=True, index=True)
    work_date: Mapped[datetime] = mapped_column(Date, nullable=False, index=True)
    client: Mapped[str] = mapped_column(String(120), nullable=False, index=True)
    area: Mapped[str] = mapped_column(String(120), nullable=False, index=True)
    description_of_work: Mapped[str | None] = mapped_column(Text, nullable=True)
    po_approval_number: Mapped[str | None] = mapped_column(String(120), nullable=True)
    created_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True, index=True)
    created_by_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
        nullable=False,
        index=True,
    )
    pdf_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    office_data: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    approved_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    approved_by_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    approved_signature: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[TMTicketStatus] = mapped_column(
        Enum(TMTicketStatus),
        nullable=False,
        default=TMTicketStatus.open,
        index=True,
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)

    rows: Mapped[list["HydroseedTicketRow"]] = relationship(
        back_populates="ticket",
        cascade="all, delete-orphan",
        order_by="HydroseedTicketRow.created_at",
    )
    daily_records: Mapped[list["HydroseedDailyRecord"]] = relationship(
        back_populates="ticket",
        foreign_keys="HydroseedDailyRecord.hydroseed_ticket_id",
    )


class HydroseedTicketRow(Base):
    """Aggregated line item on a `HydroseedTicket`. `kind` is one of
    'material' | 'equipment' | 'labour' — determines which section the row
    renders into on the HT PDF.

    Each row points at the daily record that contributed it (one per kind+label
    per daily), so the HT can show traceability AND we can re-aggregate when
    a linked daily is edited or deleted.
    """
    __tablename__ = "hydroseed_ticket_rows"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    ticket_id: Mapped[int] = mapped_column(
        ForeignKey("hydroseed_tickets.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    daily_record_id: Mapped[int | None] = mapped_column(
        ForeignKey("hydroseed_daily_records.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )
    kind: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    label: Mapped[str] = mapped_column(String(255), nullable=False)
    qty: Mapped[float | None] = mapped_column(Numeric(14, 2), nullable=True)
    unit: Mapped[str | None] = mapped_column(String(60), nullable=True)
    cost_code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)

    ticket: Mapped[HydroseedTicket] = relationship(back_populates="rows")
    daily_record: Mapped["HydroseedDailyRecord | None"] = relationship(
        back_populates="ticket_rows",
        foreign_keys=[daily_record_id],
    )


class HydroseedDailyRecord(Base):
    """Per-day field record of one or more hydroseed tank loads (HD######).
    Standalone-by-default — no required site FK. Optional `hydroseed_ticket_id`
    links to the parent HT for billing roll-up.

    `daily_data` JSONB carries the full form snapshot (header + crew + equipment
    + ingredients declaration + loads array + comments). Top-level columns are
    denormalized projections for indexed query (admin search, list views).
    """
    __tablename__ = "hydroseed_daily_records"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    record_number: Mapped[str] = mapped_column(String(50), nullable=False, unique=True, index=True)
    work_date: Mapped[datetime] = mapped_column(Date, nullable=False, index=True)
    client: Mapped[str] = mapped_column(String(120), nullable=False, index=True)
    area: Mapped[str] = mapped_column(String(120), nullable=False, index=True)
    site_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    description_of_work: Mapped[str | None] = mapped_column(Text, nullable=True)
    mulch_type: Mapped[str | None] = mapped_column(String(50), nullable=True)
    comments: Mapped[str | None] = mapped_column(Text, nullable=True)
    photo_urls: Mapped[list | None] = mapped_column(JSONB, nullable=True, default=list)
    seed_tag_photo_urls: Mapped[list | None] = mapped_column(JSONB, nullable=True, default=list)
    daily_data: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    pdf_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    site_id: Mapped[int | None] = mapped_column(ForeignKey("sites.id", ondelete="SET NULL"), nullable=True, index=True)
    hydroseed_ticket_id: Mapped[int | None] = mapped_column(
        ForeignKey("hydroseed_tickets.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    latitude: Mapped[float | None] = mapped_column(Float, nullable=True)
    longitude: Mapped[float | None] = mapped_column(Float, nullable=True)
    created_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True, index=True)
    created_by_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
        nullable=False,
        index=True,
    )
    client_submission_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)
    deleted_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)

    ticket: Mapped[HydroseedTicket | None] = relationship(
        back_populates="daily_records",
        foreign_keys=[hydroseed_ticket_id],
    )
    ticket_rows: Mapped[list[HydroseedTicketRow]] = relationship(
        back_populates="daily_record",
        cascade="all, delete-orphan",
    )


class PasswordResetCode(Base):
    """Model for storing 6-digit password reset codes.
    
    Security features:
    - Codes expire after 10 minutes
    - Max 3 attempts per code
    - Single use only (deleted after successful reset)
    - Cryptographically secure random 6-digit code
    """
    __tablename__ = "password_reset_codes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    email: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    code: Mapped[str] = mapped_column(String(6), nullable=False)
    # Token used for the actual password reset after code verification
    reset_token: Mapped[str] = mapped_column(String(64), nullable=False, unique=True, index=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    max_attempts: Mapped[int] = mapped_column(Integer, default=3, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    used_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    is_used: Mapped[bool] = mapped_column(default=False, nullable=False)

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        if not self.code:
            # Generate cryptographically secure 6-digit code
            self.code = ''.join(secrets.choice(string.digits) for _ in range(6))
        if not self.reset_token:
            # Generate secure reset token (32 bytes = 64 hex chars)
            self.reset_token = secrets.token_hex(32)
        if not self.expires_at:
            # Code expires in 10 minutes
            self.expires_at = datetime.utcnow() + timedelta(minutes=10)

    @property
    def is_expired(self) -> bool:
        return datetime.utcnow() > self.expires_at

    @property
    def is_locked(self) -> bool:
        return self.attempts >= self.max_attempts or self.is_used or self.is_expired
