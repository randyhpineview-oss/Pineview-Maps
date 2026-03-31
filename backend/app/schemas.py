from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.models import ApprovalState, PinType, RoleEnum, SiteStatus


class UserRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    email: str
    role: RoleEnum


class SiteUpdateRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    status: SiteStatus
    note: str | None
    sync_status: str
    created_at: datetime
    created_by_user_id: int | None


class SiteRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    pin_type: PinType
    lsd: str | None
    client: str | None
    area: str | None
    latitude: float
    longitude: float
    status: SiteStatus
    approval_state: ApprovalState
    gate_code: str | None
    phone_number: str | None
    notes: str | None
    source: str
    source_name: str | None
    raw_attributes: str | None
    last_inspected_at: datetime | None
    created_at: datetime
    updated_at: datetime
    created_by_user_id: int | None
    approved_by_user_id: int | None
    pending_pin_type: PinType | None = None
    updates: list[SiteUpdateRead] = Field(default_factory=list)


class SiteCreate(BaseModel):
    pin_type: PinType
    status: SiteStatus = SiteStatus.not_inspected
    lsd: str | None = None
    client: str | None = None
    area: str | None = None
    latitude: float
    longitude: float
    gate_code: str | None = None
    phone_number: str | None = None
    notes: str | None = None


class SiteStatusUpdate(BaseModel):
    status: SiteStatus
    note: str | None = None


class SiteAdminUpdate(BaseModel):
    pin_type: PinType | None = None
    lsd: str | None = None
    client: str | None = None
    area: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    gate_code: str | None = None
    phone_number: str | None = None
    notes: str | None = None


class SiteApprovalUpdate(BaseModel):
    approval_state: ApprovalState
    lsd: str | None = None
    client: str | None = None
    area: str | None = None
    notes: str | None = None
    gate_code: str | None = None
    phone_number: str | None = None


class SiteQuickEdit(BaseModel):
    gate_code: str | None = None
    phone_number: str | None = None
    notes: str | None = None


class BulkResetRequest(BaseModel):
    client: str | None = None
    area: str | None = None


class BulkResetResponse(BaseModel):
    reset_count: int


class KmlImportResponse(BaseModel):
    imported_count: int


class TypeChangeRequest(BaseModel):
    pin_type: PinType


class SessionResponse(BaseModel):
    user: UserRead
