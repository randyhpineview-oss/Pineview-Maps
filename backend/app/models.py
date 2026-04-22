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
    worker = "worker"


class SiteStatus(str, enum.Enum):
    not_inspected = "not_inspected"
    inspected = "inspected"
    issue = "issue"


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
    phone_number: Mapped[str | None] = mapped_column(String(64), nullable=True)
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
    approved_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    pending_pin_type: Mapped[PinType | None] = mapped_column(Enum(PinType), nullable=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    deleted_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)

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
    ticket_number: Mapped[str | None] = mapped_column(String(50), nullable=True, index=True)
    lease_sheet_data: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    pdf_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    photo_urls: Mapped[list | None] = mapped_column(JSONB, nullable=True, default=list)
    tm_ticket_id: Mapped[int | None] = mapped_column(
        ForeignKey("time_materials_tickets.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

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
