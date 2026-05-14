"""Pydantic v2 schemas for the Calendar API.

Read schemas expose denormalized name snapshots (`created_by_name`,
`updated_by_name`, `assigned_user_name`) so the frontend can render the
"Added by …" / creator-initials badge without a join — same trick used by
``SiteSprayRecordRead``.
"""
from __future__ import annotations

from datetime import date, datetime, time

from pydantic import BaseModel, ConfigDict, Field

from app.calendar_models import CalendarTaskPriority


# ── Common ──────────────────────────────────────────────────────────────────


class UserLite(BaseModel):
    """Slim user view for the bundle's `users` list (drives the
    "Created by" filter dropdown). Avoids leaking emails."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str


# ── Tasks ───────────────────────────────────────────────────────────────────


class CalendarTaskBase(BaseModel):
    task_date: date
    # Optional time-of-day window. Both None = all-day; start_time set =
    # timed task that renders on FullCalendar's timeGrid views.
    start_time: time | None = None
    end_time: time | None = None
    task_text: str = Field(min_length=1, max_length=2000)
    priority: CalendarTaskPriority = CalendarTaskPriority.normal
    assigned_user_id: int | None = None


class CalendarTaskCreate(CalendarTaskBase):
    pass


class CalendarTaskUpdate(BaseModel):
    # All optional — PATCH semantics. Pass only the fields you're changing.
    task_date: date | None = None
    # Note: pass `start_time: null` explicitly to clear an existing time
    # window. The route's exclude_unset=True keeps absence from clobbering.
    start_time: time | None = None
    end_time: time | None = None
    task_text: str | None = Field(default=None, min_length=1, max_length=2000)
    priority: CalendarTaskPriority | None = None
    assigned_user_id: int | None = None
    # Pass `is_completed: true` to mark complete (server stamps
    # completed_at / completed_by). Pass `false` to un-complete.
    is_completed: bool | None = None


class CalendarTaskRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    task_date: date
    original_task_date: date | None
    start_time: time | None
    end_time: time | None
    task_text: str
    priority: CalendarTaskPriority
    assigned_user_id: int | None
    assigned_user_name: str | None
    is_completed: bool
    completed_at: datetime | None
    completed_by_user_id: int | None
    completed_by_name: str | None
    created_at: datetime
    updated_at: datetime
    created_by_user_id: int | None
    created_by_name: str | None
    updated_by_user_id: int | None
    updated_by_name: str | None


# ── Contacts ────────────────────────────────────────────────────────────────


class CalendarContactBase(BaseModel):
    company_name: str = Field(min_length=1, max_length=255)
    contact_name: str | None = Field(default=None, max_length=255)
    phone: str | None = Field(default=None, max_length=64)
    email: str | None = Field(default=None, max_length=255)
    role: str | None = Field(default=None, max_length=120)
    client: str | None = Field(default=None, max_length=120)
    notes: str | None = None


class CalendarContactCreate(CalendarContactBase):
    pass


class CalendarContactUpdate(BaseModel):
    company_name: str | None = Field(default=None, min_length=1, max_length=255)
    contact_name: str | None = Field(default=None, max_length=255)
    phone: str | None = Field(default=None, max_length=64)
    email: str | None = Field(default=None, max_length=255)
    role: str | None = Field(default=None, max_length=120)
    client: str | None = Field(default=None, max_length=120)
    notes: str | None = None


class CalendarContactRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    company_name: str
    contact_name: str | None
    phone: str | None
    email: str | None
    role: str | None
    client: str | None
    notes: str | None
    created_at: datetime
    updated_at: datetime
    created_by_user_id: int | None
    created_by_name: str | None
    updated_by_user_id: int | None
    updated_by_name: str | None


# ── Events ──────────────────────────────────────────────────────────────────


class CalendarEventBase(BaseModel):
    event_date: date
    end_date: date | None = None
    # Optional time window. Same semantics as CalendarTaskBase.start_time:
    # both None = all-day; both set = timed event spanning that range.
    start_time: time | None = None
    end_time: time | None = None
    title: str = Field(min_length=1, max_length=255)
    location: str | None = Field(default=None, max_length=255)
    notes: str | None = None
    url: str | None = None


class CalendarEventCreate(CalendarEventBase):
    pass


class CalendarEventUpdate(BaseModel):
    event_date: date | None = None
    end_date: date | None = None
    start_time: time | None = None
    end_time: time | None = None
    title: str | None = Field(default=None, min_length=1, max_length=255)
    location: str | None = Field(default=None, max_length=255)
    notes: str | None = None
    url: str | None = None


class CalendarEventRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    event_date: date
    end_date: date | None
    start_time: time | None
    end_time: time | None
    title: str
    location: str | None
    notes: str | None
    url: str | None
    created_at: datetime
    updated_at: datetime
    created_by_user_id: int | None
    created_by_name: str | None
    updated_by_user_id: int | None
    updated_by_name: str | None


# ── Bids ────────────────────────────────────────────────────────────────────


class CalendarBidBase(BaseModel):
    bid_title: str = Field(min_length=1, max_length=500)
    closing_date: date | None = None
    source_url: str | None = None
    summary: str | None = None
    matched_keywords: list[str] | None = None


class CalendarBidCreate(CalendarBidBase):
    # Manual creates always land with source='manual' (server-enforced).
    # The scraper bypasses this schema and writes directly via its own helper.
    pass


class CalendarBidUpdate(BaseModel):
    bid_title: str | None = Field(default=None, min_length=1, max_length=500)
    closing_date: date | None = None
    source_url: str | None = None
    summary: str | None = None
    matched_keywords: list[str] | None = None
    is_dismissed: bool | None = None


class CalendarBidRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    bid_title: str
    closing_date: date | None
    source: str
    source_url: str | None
    summary: str | None
    matched_keywords: list[str] | None
    external_id: str | None
    is_dismissed: bool
    created_at: datetime
    updated_at: datetime
    created_by_user_id: int | None
    created_by_name: str | None


# ── Bundle ──────────────────────────────────────────────────────────────────


class CalendarBundle(BaseModel):
    """Single round-trip payload for the overlay open. Tasks / events / bids
    are date-range-scoped per the bundle endpoint's query params; contacts
    and users are always returned in full (tiny lists)."""

    tasks: list[CalendarTaskRead]
    events: list[CalendarEventRead]
    bids: list[CalendarBidRead]
    contacts: list[CalendarContactRead]
    users: list[UserLite]


class RollForwardResponse(BaseModel):
    rolled: int


class BidScanResponse(BaseModel):
    scanned: int
    matched: int
    note: str | None = None
