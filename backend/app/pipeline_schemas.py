from datetime import date, datetime
import json

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.pipeline_models import PipelineApprovalState, PipelineStatus
from app.schemas import SprayRecordApprovalUpdate, TimeMaterialsLink


class SprayRecordRead(BaseModel):
    """Full spray record (detail endpoint). Includes lease_sheet_data."""
    model_config = ConfigDict(from_attributes=True)

    id: int
    pipeline_id: int
    start_fraction: float
    end_fraction: float
    spray_date: date
    sprayed_by_user_id: int | None
    sprayed_by_name: str | None
    notes: str | None
    is_avoided: bool
    created_at: datetime
    ticket_number: str | None = None
    lease_sheet_data: dict | None = None
    pdf_url: str | None = None
    photo_urls: list[str] | None = None
    tm_ticket_id: int | None = None


class SprayRecordSummary(BaseModel):
    """Lightweight spray-record view WITHOUT lease_sheet_data.

    Used by list endpoints to keep Supabase egress tiny. The frontend
    only needs a truthy flag to decide whether to show the 📄 badge and
    the View/Edit buttons — not the full JSONB blob. For the edit flow
    the full row comes from GET /api/pipelines/{id} or an equivalent
    per-record endpoint.
    """
    model_config = ConfigDict(from_attributes=True)

    id: int
    pipeline_id: int
    start_fraction: float
    end_fraction: float
    spray_date: date
    sprayed_by_user_id: int | None
    sprayed_by_name: str | None
    notes: str | None
    is_avoided: bool
    created_at: datetime
    ticket_number: str | None = None
    pdf_url: str | None = None
    photo_urls: list[str] | None = None
    tm_ticket_id: int | None = None
    # Derived flag so the frontend can still show the "📄" lease-sheet badge
    # without hydrating the 5-10 KB JSONB blob per row. Inferred from
    # ticket_number + pdf_url so we never need to SELECT the JSONB column.
    has_lease_sheet_data: bool = False

    @model_validator(mode='after')
    def _fill_has_lease_sheet_data(self):
        # Any completed lease sheet gets a ticket_number assigned and/or a
        # pdf_url after Dropbox upload. is_avoided rows skip both.
        if not self.has_lease_sheet_data:
            self.has_lease_sheet_data = bool(self.ticket_number or self.pdf_url)
        return self


class SprayRecordCreate(BaseModel):
    start_fraction: float = Field(ge=0.0, le=1.0)
    end_fraction: float = Field(ge=0.0, le=1.0)
    spray_date: date
    notes: str | None = None
    is_avoided: bool = False
    lease_sheet_data: dict | None = None
    pdf_base64: str | None = None
    ticket_number: str | None = None
    # Optional Time & Materials linking instruction — matches the field of
    # the same name on SiteSprayRecordCreate. When present, the pipeline
    # spray endpoint creates/attaches a T&M ticket and appends a Sites
    # Treated row exactly like the site flow does.
    time_materials_link: TimeMaterialsLink | None = None


class PipelineRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str | None
    client: str | None
    area: str | None
    coordinates: list
    original_point_count: int
    simplified_point_count: int
    total_length_km: float
    status: str
    approval_state: str
    source: str
    source_name: str | None
    pipeline_metadata: dict | None
    created_at: datetime
    updated_at: datetime
    created_by_user_id: int | None
    spray_records: list[SprayRecordRead] = Field(default_factory=list)

    @field_validator('pipeline_metadata', mode='before')
    @classmethod
    def parse_metadata(cls, v):
        if isinstance(v, str):
            try:
                return json.loads(v)
            except json.JSONDecodeError:
                return None
        return v

    @field_validator('coordinates', mode='before')
    @classmethod
    def parse_coordinates(cls, v):
        if isinstance(v, str):
            try:
                return json.loads(v)
            except json.JSONDecodeError:
                return []
        return v


class PipelineListRead(BaseModel):
    """Lighter version for list endpoints — spray_records use the Summary schema
    (no lease_sheet_data) so egress stays flat regardless of how many lease
    sheets a pipeline accumulates.
    """
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str | None
    client: str | None
    area: str | None
    coordinates: list
    original_point_count: int
    simplified_point_count: int
    total_length_km: float
    status: str
    approval_state: str
    source: str
    source_name: str | None
    created_at: datetime
    updated_at: datetime
    created_by_user_id: int | None
    spray_records: list[SprayRecordSummary] = Field(default_factory=list)

    @field_validator('coordinates', mode='before')
    @classmethod
    def parse_coordinates(cls, v):
        if isinstance(v, str):
            try:
                return json.loads(v)
            except json.JSONDecodeError:
                return []
        return v


class PipelineCreate(BaseModel):
    name: str | None = None
    client: str | None = None
    area: str | None = None
    coordinates: list[list[float]]


class PipelineUpdate(BaseModel):
    name: str | None = None
    client: str | None = None
    area: str | None = None


class PipelineApprovalUpdate(BaseModel):
    approval_state: str
    name: str | None = None
    client: str | None = None
    area: str | None = None
    # Per-spray-record re-home instructions + regenerated PDFs, required
    # when approving a pipeline with meta changes and linked sheets on
    # shared T&M tickets. Mirrors SiteApprovalUpdate.
    spray_record_updates: list[SprayRecordApprovalUpdate] | None = None
    dedicated_tm_pdf_base64: str | None = None


class PipelineImportResponse(BaseModel):
    imported_count: int
    pipelines: list[PipelineListRead]


class PipelineBulkResetRequest(BaseModel):
    client: str | None = None
    area: str | None = None
    pipeline_ids: list[int] | None = None


class PipelinesDeltaResponse(BaseModel):
    """Incremental pipelines update.

    Same contract as the sites delta: `items` are rows changed-and-still-visible
    since `since`; `ids_removed` are rows that became hidden (soft-deleted or
    rejected); `server_time` is the next watermark the caller should send.
    """
    items: list[PipelineListRead]
    ids_removed: list[int]
    server_time: datetime
