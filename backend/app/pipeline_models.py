from __future__ import annotations

import enum
from datetime import datetime

from sqlalchemy import Boolean, Date, DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class PipelineStatus(str, enum.Enum):
    not_sprayed = "not_sprayed"
    sprayed = "sprayed"


class PipelineApprovalState(str, enum.Enum):
    approved = "approved"
    pending_review = "pending_review"
    rejected = "rejected"


class Pipeline(Base):
    __tablename__ = "pipelines"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    client: Mapped[str | None] = mapped_column(String(120), nullable=True, index=True)
    area: Mapped[str | None] = mapped_column(String(120), nullable=True, index=True)
    coordinates: Mapped[list] = mapped_column(JSONB, nullable=False)
    original_point_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    simplified_point_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    total_length_km: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    status: Mapped[str] = mapped_column(
        String(32), nullable=False, default="not_sprayed"
    )
    approval_state: Mapped[str] = mapped_column(
        String(32), nullable=False, default="approved", index=True
    )
    source: Mapped[str] = mapped_column(String(64), nullable=False, default="imported")
    source_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    pipeline_metadata: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )
    created_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    deleted_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)

    spray_records: Mapped[list["SprayRecord"]] = relationship(
        back_populates="pipeline",
        cascade="all, delete-orphan",
        order_by="desc(SprayRecord.created_at)",
    )


class SprayRecord(Base):
    __tablename__ = "spray_records"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    pipeline_id: Mapped[int] = mapped_column(ForeignKey("pipelines.id"), nullable=False, index=True)
    start_fraction: Mapped[float] = mapped_column(Float, nullable=False)
    end_fraction: Mapped[float] = mapped_column(Float, nullable=False)
    spray_date: Mapped[datetime] = mapped_column(Date, nullable=False)
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
    ticket_number: Mapped[str | None] = mapped_column(String(20), nullable=True, index=True)
    lease_sheet_data: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    pdf_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    photo_urls: Mapped[list] = mapped_column(JSONB, nullable=True, default=list)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)
    deleted_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    # Optional link to a Time & Materials ticket, mirroring
    # SiteSprayRecord.tm_ticket_id. Set when a pipeline lease sheet is
    # submitted with a `time_materials_link` instruction. SET NULL on ticket
    # delete so we don't cascade-delete the pipeline spray record itself.
    tm_ticket_id: Mapped[int | None] = mapped_column(
        ForeignKey("time_materials_tickets.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    pipeline: Mapped[Pipeline] = relationship(back_populates="spray_records")
    # String-keyed target class to avoid importing models.py (circular-
    # import risk: models.py imports pipeline_models indirectly via the
    # relationship graph already).
    tm_ticket: Mapped["TimeMaterialsTicket | None"] = relationship(
        "TimeMaterialsTicket",
        back_populates="pipeline_spray_records",
        foreign_keys=[tm_ticket_id],
    )
    # Companion rows on the ticket's Sites Treated table, sourced from this
    # spray record's lease sheet (one main row + optional Roadside row).
    # cascade="all, delete-orphan" mirrors the site side so deleting a
    # pipeline spray record wipes its ticket rows too.
    tm_rows: Mapped[list["TimeMaterialsRow"]] = relationship(
        "TimeMaterialsRow",
        back_populates="pipeline_spray_record",
        foreign_keys="TimeMaterialsRow.pipeline_spray_record_id",
        cascade="all, delete-orphan",
    )
