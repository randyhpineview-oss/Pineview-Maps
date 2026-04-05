from datetime import date, datetime
import json

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.pipeline_models import PipelineApprovalState, PipelineStatus


class SprayRecordRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    pipeline_id: int
    start_fraction: float
    end_fraction: float
    spray_date: date
    sprayed_by_user_id: int | None
    sprayed_by_name: str | None
    notes: str | None
    created_at: datetime


class SprayRecordCreate(BaseModel):
    start_fraction: float = Field(ge=0.0, le=1.0)
    end_fraction: float = Field(ge=0.0, le=1.0)
    spray_date: date
    notes: str | None = None


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
    status: PipelineStatus
    approval_state: PipelineApprovalState
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
    """Lighter version without full coordinates for list endpoints."""
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str | None
    client: str | None
    area: str | None
    coordinates: list
    original_point_count: int
    simplified_point_count: int
    total_length_km: float
    status: PipelineStatus
    approval_state: PipelineApprovalState
    source: str
    source_name: str | None
    created_at: datetime
    updated_at: datetime
    created_by_user_id: int | None

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
    approval_state: PipelineApprovalState
    name: str | None = None
    client: str | None = None
    area: str | None = None


class PipelineImportResponse(BaseModel):
    imported_count: int
    pipelines: list[PipelineListRead]


class PipelineBulkResetRequest(BaseModel):
    client: str | None = None
    area: str | None = None
    pipeline_ids: list[int] | None = None
