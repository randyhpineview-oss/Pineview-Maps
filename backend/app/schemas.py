from datetime import date, datetime
import json

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.models import ApprovalState, PinType, RoleEnum, SiteStatus, TMTicketStatus


class UserRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    email: str
    role: RoleEnum


class SiteSprayRecordRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    site_id: int
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


class SiteSprayRecordSummary(BaseModel):
    """Lightweight spray-record view without lease_sheet_data.

    Used by list endpoints to keep egress tiny. For the full record (edit /
    deep inspection), call GET /api/site-spray-records/{id}.
    """
    model_config = ConfigDict(from_attributes=True)

    id: int
    site_id: int
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


class TimeMaterialsLink(BaseModel):
    """Instruction for linking a lease sheet to a T&M ticket on submit."""
    ticket_id: int | None = None           # link to existing ticket
    create: bool = False                    # create new ticket from this lease sheet
    description_of_work: str | None = None  # required when create=True
    tm_pdf_base64: str | None = None        # frontend-generated T&M PDF after this row is appended


class SiteSprayRecordCreate(BaseModel):
    spray_date: date
    notes: str | None = None
    is_avoided: bool = False
    lease_sheet_data: dict | None = None
    pdf_base64: str | None = None
    ticket_number: str | None = None
    time_materials_link: TimeMaterialsLink | None = None


class SiteSprayRecordUpdate(BaseModel):
    spray_date: date | None = None
    notes: str | None = None
    is_avoided: bool | None = None
    lease_sheet_data: dict | None = None
    pdf_base64: str | None = None
    ticket_number: str | None = None
    tm_pdf_base64: str | None = None  # regenerated T&M PDF after edit propagation


class RecentSubmissionRead(BaseModel):
    """Lightweight recent-submission row — NO lease_sheet_data.

    The PDF preview fetches the real Dropbox PDF via /api/pdf-proxy; the edit
    flow fetches the full record via /api/site-spray-records/{id}.
    """
    model_config = ConfigDict(from_attributes=True)

    id: int
    site_id: int
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
    # Joined site context
    site_lsd: str | None = None
    site_client: str | None = None
    site_area: str | None = None


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
    raw_attributes: dict | None
    last_inspected_at: datetime | None
    last_inspected_by_user_id: int | None
    last_inspected_by_email: str | None
    last_inspected_by_name: str | None
    created_at: datetime
    updated_at: datetime
    created_by_user_id: int | None
    approved_by_user_id: int | None
    pending_pin_type: PinType | None = None
    updates: list[SiteUpdateRead] = Field(default_factory=list)
    spray_records: list[SiteSprayRecordSummary] = Field(default_factory=list)
    # Nested user objects for convenience
    created_by_user: UserRead | None = None
    approved_by_user: UserRead | None = None
    last_inspected_by_user: UserRead | None = None

    @field_validator('raw_attributes', mode='before')
    @classmethod
    def parse_raw_attributes(cls, v):
        if isinstance(v, str):
            try:
                return json.loads(v)
            except json.JSONDecodeError:
                return None
        return v


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


# ── Delta-sync response envelopes ──
#
# Each delta endpoint returns a small payload describing what changed since
# the caller's last-seen timestamp, rather than the entire resource list.
# The frontend uses `server_time` as the next `?since=...` value so clocks
# don't drift and nothing is ever skipped.


class SitesDeltaResponse(BaseModel):
    """Incremental sites update.

    `items` — sites created/updated (and still visible) since `since`.
    `ids_removed` — site IDs that were soft-deleted or rejected since `since`;
    frontend should drop them from its cache/map.
    `server_time` — pass this back as `?since=` on the next call.
    """
    items: list[SiteRead]
    ids_removed: list[int]
    server_time: datetime


class RecentSubmissionsDeltaResponse(BaseModel):
    """Incremental recent-submissions update. Append-only: no removal list
    needed because these are typically created and never deleted. Only new
    submissions since `since` are returned, already capped by the server."""
    items: list[RecentSubmissionRead]
    server_time: datetime


# ── Time & Materials Ticket schemas ──

class TimeMaterialsRowRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    ticket_id: int
    spray_record_id: int
    location: str | None = None
    site_type: str | None = None
    herbicides: str | None = None
    liters_used: float | None = None
    area_ha: float | None = None
    cost_code: str | None = None
    created_at: datetime


class TimeMaterialsRowUpdate(BaseModel):
    location: str | None = None
    site_type: str | None = None
    herbicides: str | None = None
    liters_used: float | None = None
    area_ha: float | None = None
    cost_code: str | None = None


class TimeMaterialsTicketRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    ticket_number: str
    spray_date: date
    client: str
    area: str
    description_of_work: str | None = None
    po_approval_number: str | None = None
    created_by_user_id: int | None = None
    created_by_name: str | None = None
    created_at: datetime
    updated_at: datetime
    pdf_url: str | None = None
    office_data: dict | None = None  # stripped for worker role in endpoint
    approved_by_user_id: int | None = None
    approved_by_name: str | None = None
    approved_at: datetime | None = None
    approved_signature: str | None = None  # stripped for worker role in endpoint
    status: TMTicketStatus
    rows: list[TimeMaterialsRowRead] = Field(default_factory=list)


class TimeMaterialsTicketCreate(BaseModel):
    spray_date: date
    client: str
    area: str
    description_of_work: str | None = None


class TimeMaterialsTicketUpdate(BaseModel):
    description_of_work: str | None = None
    po_approval_number: str | None = None
    office_data: dict | None = None
    status: TMTicketStatus | None = None
    pdf_base64: str | None = None
    approved_signature: str | None = None   # base64 PNG from draw-pad
    approve: bool = False                    # set approved_by/at, status=approved
    row_updates: list[dict] | None = None    # [{ id, cost_code, ... }] batch update rows
