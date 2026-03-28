from __future__ import annotations

import enum
from datetime import datetime

from sqlalchemy import DateTime, Enum, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class RoleEnum(str, enum.Enum):
    admin = "admin"
    office = "office"
    worker = "worker"


class SiteStatus(str, enum.Enum):
    not_inspected = "not_inspected"
    inspected = "inspected"


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
    raw_attributes: Mapped[str | None] = mapped_column(Text, nullable=True)
    last_inspected_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
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

    created_by_user: Mapped[User | None] = relationship(
        back_populates="created_sites",
        foreign_keys=[created_by_user_id],
    )
    approved_by_user: Mapped[User | None] = relationship(
        back_populates="approved_sites",
        foreign_keys=[approved_by_user_id],
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
