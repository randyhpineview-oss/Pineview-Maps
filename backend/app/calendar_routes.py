"""FastAPI routes for the admin/office Calendar feature.

All endpoints are gated by ``require_roles(admin, office)`` — workers get a
403. Every write path stamps ``created_by_*`` / ``updated_by_*`` from the
authenticated ``current_user`` so attribution can't be spoofed by a tampered
request body.
"""
from __future__ import annotations

import os
from datetime import date, datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.auth import get_current_user, require_roles
from app.calendar_models import (
    CalendarBid,
    CalendarContact,
    CalendarEvent,
    CalendarTask,
    CalendarTaskPriority,
)
from app.calendar_schemas import (
    BidScanResponse,
    CalendarBidCreate,
    CalendarBidRead,
    CalendarBidUpdate,
    CalendarBundle,
    CalendarContactCreate,
    CalendarContactRead,
    CalendarContactUpdate,
    CalendarEventCreate,
    CalendarEventRead,
    CalendarEventUpdate,
    CalendarTaskCreate,
    CalendarTaskRead,
    CalendarTaskUpdate,
    RollForwardResponse,
    UserLite,
)
from app.database import get_db
from app.log_util import get_logger
from app.models import RoleEnum, User

logger = get_logger(__name__)

router = APIRouter(
    prefix="/api/calendar",
    tags=["calendar"],
    dependencies=[Depends(require_roles(RoleEnum.admin, RoleEnum.office))],
)


# ── Helpers ─────────────────────────────────────────────────────────────────


def _default_range() -> tuple[date, date]:
    """Default visible window when no ``from``/``to`` is supplied:
    current month minus one week through plus one month, matching what the
    overlay typically renders on first open."""
    today = date.today()
    start = (today.replace(day=1)) - timedelta(days=7)
    end = today + timedelta(days=31)
    return start, end


def _stamp_create(obj, user: User) -> None:
    obj.created_by_user_id = user.id
    obj.created_by_name = user.name
    obj.updated_by_user_id = user.id
    obj.updated_by_name = user.name


def _stamp_update(obj, user: User) -> None:
    obj.updated_by_user_id = user.id
    obj.updated_by_name = user.name


def _resolve_assigned_user(db: Session, user_id: Optional[int]) -> Optional[str]:
    """Look up the assigned user's name for the denormalized snapshot. Returns
    None if the id is None or the row doesn't exist (treat as "unassigned"
    rather than 400ing the caller — UX is friendlier)."""
    if user_id is None:
        return None
    u = db.query(User).filter(User.id == user_id).first()
    return u.name if u is not None else None


def _admin_office_users(db: Session) -> list[UserLite]:
    """Slim user list for the "Created by" filter dropdown. Workers excluded
    because they can't write to the calendar in the first place — would just
    pollute the dropdown."""
    rows = (
        db.query(User)
        .filter(User.role.in_([RoleEnum.admin, RoleEnum.office]))
        .order_by(User.name.asc())
        .all()
    )
    return [UserLite.model_validate(r) for r in rows]


# ── Bundle (single round-trip on overlay open) ──────────────────────────────


@router.get("/bundle", response_model=CalendarBundle)
def get_bundle(
    from_: Optional[date] = Query(None, alias="from"),
    to: Optional[date] = None,
    created_by: Optional[int] = Query(None),
    include_completed: bool = Query(True),
    include_dismissed: bool = Query(False),
    db: Session = Depends(get_db),
) -> CalendarBundle:
    if from_ is None or to is None:
        d_from, d_to = _default_range()
        if from_ is None:
            from_ = d_from
        if to is None:
            to = d_to
    if from_ > to:
        raise HTTPException(status_code=400, detail="`from` must be <= `to`")

    # Tasks
    tasks_q = db.query(CalendarTask).filter(
        CalendarTask.deleted_at.is_(None),
        CalendarTask.task_date >= from_,
        CalendarTask.task_date <= to,
    )
    if created_by is not None:
        tasks_q = tasks_q.filter(CalendarTask.created_by_user_id == created_by)
    if not include_completed:
        tasks_q = tasks_q.filter(CalendarTask.is_completed.is_(False))
    tasks = tasks_q.order_by(CalendarTask.task_date.asc(), CalendarTask.id.asc()).all()

    # Events. A multi-day event with end_date >= from is visible even if
    # event_date < from (it started earlier and is still running), so the
    # date filter uses an OR across both columns.
    events_q = db.query(CalendarEvent).filter(
        CalendarEvent.deleted_at.is_(None),
        (
            ((CalendarEvent.event_date >= from_) & (CalendarEvent.event_date <= to))
            | (
                (CalendarEvent.end_date.isnot(None))
                & (CalendarEvent.event_date <= to)
                & (CalendarEvent.end_date >= from_)
            )
        ),
    )
    if created_by is not None:
        events_q = events_q.filter(CalendarEvent.created_by_user_id == created_by)
    events = events_q.order_by(CalendarEvent.event_date.asc(), CalendarEvent.id.asc()).all()

    # Bids. Closing-date can be NULL (un-parseable from scraper) — those
    # always come along so the UI can show them in the "no date" bucket.
    bids_q = db.query(CalendarBid).filter(CalendarBid.deleted_at.is_(None))
    if not include_dismissed:
        bids_q = bids_q.filter(CalendarBid.is_dismissed.is_(False))
    bids_q = bids_q.filter(
        (CalendarBid.closing_date.is_(None))
        | (
            (CalendarBid.closing_date >= from_) & (CalendarBid.closing_date <= to)
        )
    )
    bids = bids_q.order_by(
        CalendarBid.closing_date.asc().nullsfirst(),
        CalendarBid.id.asc(),
    ).all()

    # Contacts always returned in full — no date column to scope by, and the
    # list is small (dozens, not thousands) so egress is fine.
    contacts = (
        db.query(CalendarContact)
        .filter(CalendarContact.deleted_at.is_(None))
        .order_by(CalendarContact.client.asc().nullslast(), CalendarContact.company_name.asc())
        .all()
    )

    return CalendarBundle(
        tasks=[CalendarTaskRead.model_validate(t) for t in tasks],
        events=[CalendarEventRead.model_validate(e) for e in events],
        bids=[CalendarBidRead.model_validate(b) for b in bids],
        contacts=[CalendarContactRead.model_validate(c) for c in contacts],
        users=_admin_office_users(db),
    )


# ── Tasks CRUD ──────────────────────────────────────────────────────────────


@router.get("/tasks", response_model=list[CalendarTaskRead])
def list_tasks(
    from_: Optional[date] = Query(None, alias="from"),
    to: Optional[date] = None,
    created_by: Optional[int] = Query(None),
    include_completed: bool = Query(True),
    db: Session = Depends(get_db),
) -> list[CalendarTaskRead]:
    if from_ is None or to is None:
        d_from, d_to = _default_range()
        if from_ is None:
            from_ = d_from
        if to is None:
            to = d_to
    q = db.query(CalendarTask).filter(
        CalendarTask.deleted_at.is_(None),
        CalendarTask.task_date >= from_,
        CalendarTask.task_date <= to,
    )
    if created_by is not None:
        q = q.filter(CalendarTask.created_by_user_id == created_by)
    if not include_completed:
        q = q.filter(CalendarTask.is_completed.is_(False))
    rows = q.order_by(CalendarTask.task_date.asc(), CalendarTask.id.asc()).all()
    return [CalendarTaskRead.model_validate(r) for r in rows]


@router.post("/tasks", response_model=CalendarTaskRead, status_code=status.HTTP_201_CREATED)
def create_task(
    payload: CalendarTaskCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> CalendarTaskRead:
    task = CalendarTask(
        task_date=payload.task_date,
        task_text=payload.task_text.strip(),
        priority=payload.priority.value,
        assigned_user_id=payload.assigned_user_id,
        assigned_user_name=_resolve_assigned_user(db, payload.assigned_user_id),
    )
    _stamp_create(task, current_user)
    db.add(task)
    db.commit()
    db.refresh(task)
    return CalendarTaskRead.model_validate(task)


@router.patch("/tasks/{task_id}", response_model=CalendarTaskRead)
def update_task(
    task_id: int,
    payload: CalendarTaskUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> CalendarTaskRead:
    task = db.query(CalendarTask).filter(
        CalendarTask.id == task_id, CalendarTask.deleted_at.is_(None)
    ).first()
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")

    changes = payload.model_dump(exclude_unset=True)

    # is_completed transitions stamp completed_at/by; un-completing clears them.
    if "is_completed" in changes:
        new_value = bool(changes["is_completed"])
        if new_value and not task.is_completed:
            task.is_completed = True
            task.completed_at = datetime.utcnow()
            task.completed_by_user_id = current_user.id
            task.completed_by_name = current_user.name
        elif not new_value and task.is_completed:
            task.is_completed = False
            task.completed_at = None
            task.completed_by_user_id = None
            task.completed_by_name = None
        changes.pop("is_completed")

    if "assigned_user_id" in changes:
        new_id = changes.pop("assigned_user_id")
        task.assigned_user_id = new_id
        task.assigned_user_name = _resolve_assigned_user(db, new_id)

    if "priority" in changes:
        priority = changes.pop("priority")
        # Pydantic gives us the enum; SQLAlchemy column stores the string.
        task.priority = priority.value if isinstance(priority, CalendarTaskPriority) else str(priority)

    for field_name, value in changes.items():
        if field_name == "task_text" and isinstance(value, str):
            value = value.strip()
        setattr(task, field_name, value)

    _stamp_update(task, current_user)
    db.commit()
    db.refresh(task)
    return CalendarTaskRead.model_validate(task)


@router.delete("/tasks/{task_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_task(
    task_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    task = db.query(CalendarTask).filter(
        CalendarTask.id == task_id, CalendarTask.deleted_at.is_(None)
    ).first()
    if task is None:
        # Idempotent: deleting an already-deleted task is a no-op so retries
        # from a flaky network don't 404.
        return
    task.deleted_at = datetime.utcnow()
    _stamp_update(task, current_user)
    db.commit()


@router.post("/tasks/roll-forward", response_model=RollForwardResponse)
def roll_forward_tasks(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> RollForwardResponse:
    """Bump task_date to TODAY for every incomplete, non-deleted task whose
    task_date is in the past. Idempotent — safe to call many times per day.

    Stamps ``original_task_date`` on the FIRST roll only (where it's currently
    NULL) so the audit trail survives subsequent rolls.
    """
    today = date.today()
    rows = (
        db.query(CalendarTask)
        .filter(
            CalendarTask.deleted_at.is_(None),
            CalendarTask.is_completed.is_(False),
            CalendarTask.task_date < today,
        )
        .all()
    )
    rolled = 0
    for r in rows:
        if r.original_task_date is None:
            r.original_task_date = r.task_date
        r.task_date = today
        # Roll-forward is a system-driven update — stamp the triggering user
        # so we can debug a stuck task ("who keeps rolling this?").
        _stamp_update(r, current_user)
        rolled += 1
    db.commit()
    return RollForwardResponse(rolled=rolled)


# ── Contacts CRUD ───────────────────────────────────────────────────────────


@router.get("/contacts", response_model=list[CalendarContactRead])
def list_contacts(db: Session = Depends(get_db)) -> list[CalendarContactRead]:
    rows = (
        db.query(CalendarContact)
        .filter(CalendarContact.deleted_at.is_(None))
        .order_by(CalendarContact.client.asc().nullslast(), CalendarContact.company_name.asc())
        .all()
    )
    return [CalendarContactRead.model_validate(r) for r in rows]


@router.post("/contacts", response_model=CalendarContactRead, status_code=status.HTTP_201_CREATED)
def create_contact(
    payload: CalendarContactCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> CalendarContactRead:
    contact = CalendarContact(**payload.model_dump())
    _stamp_create(contact, current_user)
    db.add(contact)
    db.commit()
    db.refresh(contact)
    return CalendarContactRead.model_validate(contact)


@router.patch("/contacts/{contact_id}", response_model=CalendarContactRead)
def update_contact(
    contact_id: int,
    payload: CalendarContactUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> CalendarContactRead:
    contact = db.query(CalendarContact).filter(
        CalendarContact.id == contact_id, CalendarContact.deleted_at.is_(None)
    ).first()
    if contact is None:
        raise HTTPException(status_code=404, detail="Contact not found")
    for field_name, value in payload.model_dump(exclude_unset=True).items():
        setattr(contact, field_name, value)
    _stamp_update(contact, current_user)
    db.commit()
    db.refresh(contact)
    return CalendarContactRead.model_validate(contact)


@router.delete("/contacts/{contact_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_contact(
    contact_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    contact = db.query(CalendarContact).filter(
        CalendarContact.id == contact_id, CalendarContact.deleted_at.is_(None)
    ).first()
    if contact is None:
        return
    contact.deleted_at = datetime.utcnow()
    _stamp_update(contact, current_user)
    db.commit()


# ── Events CRUD ─────────────────────────────────────────────────────────────


@router.get("/events", response_model=list[CalendarEventRead])
def list_events(
    from_: Optional[date] = Query(None, alias="from"),
    to: Optional[date] = None,
    created_by: Optional[int] = Query(None),
    db: Session = Depends(get_db),
) -> list[CalendarEventRead]:
    if from_ is None or to is None:
        d_from, d_to = _default_range()
        if from_ is None:
            from_ = d_from
        if to is None:
            to = d_to
    q = db.query(CalendarEvent).filter(
        CalendarEvent.deleted_at.is_(None),
        (
            ((CalendarEvent.event_date >= from_) & (CalendarEvent.event_date <= to))
            | (
                (CalendarEvent.end_date.isnot(None))
                & (CalendarEvent.event_date <= to)
                & (CalendarEvent.end_date >= from_)
            )
        ),
    )
    if created_by is not None:
        q = q.filter(CalendarEvent.created_by_user_id == created_by)
    rows = q.order_by(CalendarEvent.event_date.asc(), CalendarEvent.id.asc()).all()
    return [CalendarEventRead.model_validate(r) for r in rows]


@router.post("/events", response_model=CalendarEventRead, status_code=status.HTTP_201_CREATED)
def create_event(
    payload: CalendarEventCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> CalendarEventRead:
    if payload.end_date is not None and payload.end_date < payload.event_date:
        raise HTTPException(status_code=400, detail="`end_date` must be on or after `event_date`")
    event = CalendarEvent(**payload.model_dump())
    _stamp_create(event, current_user)
    db.add(event)
    db.commit()
    db.refresh(event)
    return CalendarEventRead.model_validate(event)


@router.patch("/events/{event_id}", response_model=CalendarEventRead)
def update_event(
    event_id: int,
    payload: CalendarEventUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> CalendarEventRead:
    event = db.query(CalendarEvent).filter(
        CalendarEvent.id == event_id, CalendarEvent.deleted_at.is_(None)
    ).first()
    if event is None:
        raise HTTPException(status_code=404, detail="Event not found")

    changes = payload.model_dump(exclude_unset=True)
    for field_name, value in changes.items():
        setattr(event, field_name, value)

    # Cross-field validation after the patch is applied.
    if event.end_date is not None and event.end_date < event.event_date:
        raise HTTPException(status_code=400, detail="`end_date` must be on or after `event_date`")

    _stamp_update(event, current_user)
    db.commit()
    db.refresh(event)
    return CalendarEventRead.model_validate(event)


@router.delete("/events/{event_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_event(
    event_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    event = db.query(CalendarEvent).filter(
        CalendarEvent.id == event_id, CalendarEvent.deleted_at.is_(None)
    ).first()
    if event is None:
        return
    event.deleted_at = datetime.utcnow()
    _stamp_update(event, current_user)
    db.commit()


# ── Bids CRUD ───────────────────────────────────────────────────────────────


@router.get("/bids", response_model=list[CalendarBidRead])
def list_bids(
    include_dismissed: bool = Query(False),
    db: Session = Depends(get_db),
) -> list[CalendarBidRead]:
    q = db.query(CalendarBid).filter(CalendarBid.deleted_at.is_(None))
    if not include_dismissed:
        q = q.filter(CalendarBid.is_dismissed.is_(False))
    rows = q.order_by(CalendarBid.closing_date.asc().nullsfirst(), CalendarBid.id.asc()).all()
    return [CalendarBidRead.model_validate(r) for r in rows]


@router.post("/bids", response_model=CalendarBidRead, status_code=status.HTTP_201_CREATED)
def create_bid(
    payload: CalendarBidCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> CalendarBidRead:
    # Manual bids always source='manual' — server-enforced, since the schema
    # doesn't expose the field.
    bid = CalendarBid(
        bid_title=payload.bid_title.strip(),
        closing_date=payload.closing_date,
        source="manual",
        source_url=payload.source_url,
        summary=payload.summary,
        matched_keywords=payload.matched_keywords,
    )
    _stamp_create(bid, current_user)
    db.add(bid)
    db.commit()
    db.refresh(bid)
    return CalendarBidRead.model_validate(bid)


@router.patch("/bids/{bid_id}", response_model=CalendarBidRead)
def update_bid(
    bid_id: int,
    payload: CalendarBidUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> CalendarBidRead:
    bid = db.query(CalendarBid).filter(
        CalendarBid.id == bid_id, CalendarBid.deleted_at.is_(None)
    ).first()
    if bid is None:
        raise HTTPException(status_code=404, detail="Bid not found")
    for field_name, value in payload.model_dump(exclude_unset=True).items():
        setattr(bid, field_name, value)
    _stamp_update(bid, current_user)
    db.commit()
    db.refresh(bid)
    return CalendarBidRead.model_validate(bid)


@router.delete("/bids/{bid_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_bid(
    bid_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    bid = db.query(CalendarBid).filter(
        CalendarBid.id == bid_id, CalendarBid.deleted_at.is_(None)
    ).first()
    if bid is None:
        return
    bid.deleted_at = datetime.utcnow()
    _stamp_update(bid, current_user)
    db.commit()


# ── Bid scanner stub ────────────────────────────────────────────────────────


@router.post(
    "/bids/scan",
    response_model=BidScanResponse,
    # Override the router-level auth dependency: the scan endpoint is called
    # by a GitHub Actions cron with no user JWT, only a shared secret. We
    # validate that secret explicitly inside the handler.
    dependencies=[],
)
def scan_bids(
    x_bid_scan_secret: Optional[str] = Header(default=None, alias="X-Bid-Scan-Secret"),
) -> BidScanResponse:
    """Stub endpoint for the future daily bid scanner.

    Once the scraper lands in ``app.bid_scanner``, replace the stub body with::

        result = app.bid_scanner.run(db)
        return BidScanResponse(scanned=result.scanned, matched=result.matched)

    The shared secret keeps the endpoint out of reach of the public until the
    real scraper is wired up. Configure ``BID_SCAN_SECRET`` in the backend
    env vars (Render) and as a GitHub Actions secret of the same name.
    """
    expected = os.environ.get("BID_SCAN_SECRET")
    if not expected:
        # Don't return 500 — that would mask the misconfiguration as a cron
        # failure. Be explicit: the operator needs to set the env var.
        raise HTTPException(
            status_code=503,
            detail="BID_SCAN_SECRET is not configured on the server.",
        )
    if x_bid_scan_secret != expected:
        raise HTTPException(status_code=403, detail="Invalid scan secret")
    return BidScanResponse(scanned=0, matched=0, note="scanner not implemented yet")
