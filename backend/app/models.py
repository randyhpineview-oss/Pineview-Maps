from __future__ import annotations

import enum
import secrets
import string
from datetime import datetime, timedelta

from sqlalchemy import DateTime, Enum, Float, ForeignKey, Integer, String, Text, Boolean
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


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

    site: Mapped[Site] = relationship(back_populates="spray_records")


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
