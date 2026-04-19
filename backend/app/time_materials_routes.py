"""Endpoints for Time & Materials tickets.

Shared ticket sequence with Herbicide Lease Sheets via ticket_seq.
Workers can only view/edit their own tickets; office/admin see all and can fill office_data.
"""
from datetime import date, datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import or_, text
from sqlalchemy.orm import Session, joinedload

from app.auth import get_current_user, require_roles
from app.database import get_db
from app.models import (
    RoleEnum,
    SiteSprayRecord,
    TMTicketStatus,
    TimeMaterialsRow,
    TimeMaterialsTicket,
    User,
)
from app.schemas import (
    TimeMaterialsRowRead,
    TimeMaterialsTicketCreate,
    TimeMaterialsTicketRead,
    TimeMaterialsTicketUpdate,
)

router = APIRouter(prefix="/api/time-materials", tags=["time-materials"])


def _strip_office_fields_for_worker(
    ticket: TimeMaterialsTicket, current_user: User
) -> TimeMaterialsTicketRead:
    """Convert a ticket to its Read schema, stripping office-only fields for workers."""
    data = TimeMaterialsTicketRead.model_validate(ticket)
    if current_user.role == RoleEnum.worker:
        data = data.model_copy(update={
            "office_data": None,
            "approved_signature": None,
        })
    return data


def _can_edit_ticket(ticket: TimeMaterialsTicket, current_user: User) -> bool:
    """Workers can only edit their own tickets. Office/admin can edit any."""
    if current_user.role in (RoleEnum.admin, RoleEnum.office):
        return True
    return ticket.created_by_user_id is not None and ticket.created_by_user_id == current_user.id


def _visible_query(db: Session, current_user: User):
    """Base query scoped to what the current user can see."""
    q = db.query(TimeMaterialsTicket).options(joinedload(TimeMaterialsTicket.rows))
    if current_user.role == RoleEnum.worker:
        q = q.filter(TimeMaterialsTicket.created_by_user_id == current_user.id)
    return q


def _allocate_ticket_number(db: Session) -> str:
    result = db.execute(text("SELECT nextval('ticket_seq')"))
    seq_value = result.scalar()
    return f"T{seq_value:06d}"


def _upload_tm_pdf(ticket: TimeMaterialsTicket, pdf_base64: str) -> Optional[str]:
    """Upload the given base64 PDF to Dropbox for this ticket. Returns shared link or None."""
    import base64 as b64
    from app.dropbox_integration import build_tm_path, upload_pdf_to_dropbox

    try:
        pdf_content = b64.b64decode(pdf_base64)
        path = build_tm_path(
            date_str=str(ticket.spray_date),
            client=ticket.client or "",
            area=ticket.area or "",
            ticket=ticket.ticket_number or "",
        )
        return upload_pdf_to_dropbox(pdf_content, path)
    except Exception as e:
        print(f"[TM] Error uploading PDF: {e}")
        return None


# ── Open/List ────────────────────────────────────────────────────

@router.get("/open", response_model=list[TimeMaterialsTicketRead])
def list_open_tickets(
    client: str | None = Query(default=None),
    area: str | None = Query(default=None),
    spray_date: date | None = Query(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List open T&M tickets for the linking step in the lease sheet submit flow.

    Workers see only their own tickets. Office/admin see all.
    """
    q = _visible_query(db, current_user).filter(TimeMaterialsTicket.status == TMTicketStatus.open)
    if client:
        q = q.filter(TimeMaterialsTicket.client == client)
    if area:
        q = q.filter(TimeMaterialsTicket.area == area)
    if spray_date:
        q = q.filter(TimeMaterialsTicket.spray_date == spray_date)

    tickets = q.order_by(TimeMaterialsTicket.created_at.desc()).all()
    return [_strip_office_fields_for_worker(t, current_user) for t in tickets]


@router.get("", response_model=list[TimeMaterialsTicketRead])
def list_tickets(
    status_filter: TMTicketStatus | None = Query(default=None, alias="status"),
    spray_date: date | None = Query(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List all visible T&M tickets (workers see their own)."""
    q = _visible_query(db, current_user)
    if status_filter is not None:
        q = q.filter(TimeMaterialsTicket.status == status_filter)
    if spray_date:
        q = q.filter(TimeMaterialsTicket.spray_date == spray_date)
    tickets = q.order_by(TimeMaterialsTicket.created_at.desc()).limit(200).all()
    return [_strip_office_fields_for_worker(t, current_user) for t in tickets]


# ── Detail ───────────────────────────────────────────────────────

@router.get("/{ticket_id}", response_model=TimeMaterialsTicketRead)
def get_ticket(
    ticket_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    ticket = _visible_query(db, current_user).filter(TimeMaterialsTicket.id == ticket_id).first()
    if not ticket:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Ticket not found")
    return _strip_office_fields_for_worker(ticket, current_user)


# ── Create ───────────────────────────────────────────────────────

@router.post("", response_model=TimeMaterialsTicketRead, status_code=status.HTTP_201_CREATED)
def create_ticket(
    payload: TimeMaterialsTicketCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Create a new open T&M ticket. Shared ticket_seq."""
    ticket_number = _allocate_ticket_number(db)

    created_by_user_id = None
    if current_user.id:
        local_user = db.query(User).filter(User.id == current_user.id).first()
        if local_user:
            created_by_user_id = current_user.id

    user_name = getattr(current_user, "name", None) or (
        current_user.email.split("@")[0].title() if current_user.email else None
    )

    ticket = TimeMaterialsTicket(
        ticket_number=ticket_number,
        spray_date=payload.spray_date,
        client=payload.client,
        area=payload.area,
        description_of_work=payload.description_of_work,
        created_by_user_id=created_by_user_id,
        created_by_name=user_name,
        status=TMTicketStatus.open,
    )
    db.add(ticket)
    db.commit()
    db.refresh(ticket)
    return _strip_office_fields_for_worker(ticket, current_user)


# ── Update ───────────────────────────────────────────────────────

@router.patch("/{ticket_id}", response_model=TimeMaterialsTicketRead)
def update_ticket(
    ticket_id: int,
    payload: TimeMaterialsTicketUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update a T&M ticket. Workers can only edit their own and cannot touch office-only fields."""
    ticket = db.query(TimeMaterialsTicket).options(joinedload(TimeMaterialsTicket.rows)).filter(
        TimeMaterialsTicket.id == ticket_id
    ).first()
    if not ticket:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Ticket not found")
    if not _can_edit_ticket(ticket, current_user):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not allowed")

    is_office = current_user.role in (RoleEnum.admin, RoleEnum.office)

    # Worker-editable fields
    if payload.description_of_work is not None:
        ticket.description_of_work = payload.description_of_work

    # Office-only fields
    if is_office:
        if payload.po_approval_number is not None:
            ticket.po_approval_number = payload.po_approval_number
        if payload.office_data is not None:
            ticket.office_data = payload.office_data
        if payload.status is not None:
            ticket.status = payload.status
        if payload.approved_signature is not None:
            ticket.approved_signature = payload.approved_signature
        if payload.approve:
            ticket.status = TMTicketStatus.approved
            ticket.approved_at = datetime.utcnow()
            if current_user.id:
                local_user = db.query(User).filter(User.id == current_user.id).first()
                if local_user:
                    ticket.approved_by_user_id = current_user.id
            ticket.approved_by_name = getattr(current_user, "name", None) or (
                current_user.email.split("@")[0].title() if current_user.email else None
            )
        if payload.row_updates:
            for ru in payload.row_updates:
                rid = ru.get("id")
                if rid is None:
                    continue
                row = db.query(TimeMaterialsRow).filter(
                    TimeMaterialsRow.id == rid,
                    TimeMaterialsRow.ticket_id == ticket.id,
                ).first()
                if not row:
                    continue
                for fld in ("location", "site_type", "herbicides", "liters_used", "area_ha", "cost_code"):
                    if fld in ru and ru[fld] is not None:
                        setattr(row, fld, ru[fld])
    else:
        # Worker attempted to set office-only fields — reject silently by ignoring them.
        if any([
            payload.po_approval_number is not None,
            payload.office_data is not None,
            payload.approved_signature is not None,
            payload.approve,
        ]):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Office-only fields")

    # Upload new PDF if provided (always overwrite existing Dropbox file)
    if payload.pdf_base64:
        new_url = _upload_tm_pdf(ticket, payload.pdf_base64)
        if new_url:
            ticket.pdf_url = new_url

    ticket.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(ticket)
    return _strip_office_fields_for_worker(ticket, current_user)


@router.delete(
    "/{ticket_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_roles(RoleEnum.admin, RoleEnum.office))],
)
def delete_ticket(
    ticket_id: int,
    db: Session = Depends(get_db),
):
    ticket = db.query(TimeMaterialsTicket).filter(TimeMaterialsTicket.id == ticket_id).first()
    if not ticket:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Ticket not found")
    # Unlink spray records rather than cascade-delete (rows cascade automatically via FK)
    for rec in list(ticket.spray_records):
        rec.tm_ticket_id = None
    db.delete(ticket)
    db.commit()


# ── Row helpers used internally by spray record endpoints ────────

def derive_row_from_spray_record(record: SiteSprayRecord) -> dict:
    """Derive T&M row fields from a site spray record's lease_sheet_data + site."""
    data = record.lease_sheet_data or {}
    herb_list = data.get("herbicidesUsed") or []
    if len(herb_list) == 0:
        herbicides_text = ""
    elif len(herb_list) == 1:
        herbicides_text = herb_list[0]
    else:
        herbicides_text = f"{len(herb_list)} Herbicides"

    # Site type from linked site (Wellsite for LSD, etc.)
    site = getattr(record, "site", None)
    site_type = None
    if site is not None:
        pin_type = getattr(site, "pin_type", None)
        pin_val = pin_type.value if pin_type is not None and hasattr(pin_type, "value") else pin_type
        type_map = {"lsd": "Wellsite", "water": "Water", "quad_access": "Quad Access", "reclaimed": "Reclaimed"}
        site_type = type_map.get(pin_val, "")

    def _to_float(v):
        try:
            return float(v) if v not in (None, "", "___") else None
        except (ValueError, TypeError):
            return None

    return {
        "location": data.get("lsdOrPipeline") or (site.lsd if site else None),
        "site_type": site_type,
        "herbicides": herbicides_text,
        "liters_used": _to_float(data.get("totalLiters")),
        "area_ha": _to_float(data.get("areaTreated")),
    }


def append_row_for_spray_record(
    db: Session,
    ticket: TimeMaterialsTicket,
    record: SiteSprayRecord,
) -> TimeMaterialsRow:
    """Create (or update existing) row for a spray record on the given ticket."""
    row = db.query(TimeMaterialsRow).filter(
        TimeMaterialsRow.spray_record_id == record.id
    ).first()
    fields = derive_row_from_spray_record(record)

    if row:
        for k, v in fields.items():
            if v is not None:
                setattr(row, k, v)
        if row.ticket_id != ticket.id:
            row.ticket_id = ticket.id
    else:
        row = TimeMaterialsRow(
            ticket_id=ticket.id,
            spray_record_id=record.id,
            **fields,
        )
        db.add(row)

    record.tm_ticket_id = ticket.id
    ticket.updated_at = datetime.utcnow()
    db.flush()
    return row


def find_or_create_ticket_for_link(
    db: Session,
    record: SiteSprayRecord,
    link_ticket_id: Optional[int],
    link_create: bool,
    description_of_work: Optional[str],
    current_user: User,
) -> Optional[TimeMaterialsTicket]:
    """Resolve a time_materials_link into a concrete ticket to append the row to."""
    if link_ticket_id is not None:
        ticket = db.query(TimeMaterialsTicket).filter(TimeMaterialsTicket.id == link_ticket_id).first()
        if not ticket:
            return None
        # Workers may only attach to their own open tickets
        if current_user.role == RoleEnum.worker:
            if ticket.created_by_user_id != current_user.id:
                return None
        return ticket

    if link_create:
        ticket_number = _allocate_ticket_number(db)
        created_by_user_id = None
        if current_user.id:
            local_user = db.query(User).filter(User.id == current_user.id).first()
            if local_user:
                created_by_user_id = current_user.id
        user_name = getattr(current_user, "name", None) or (
            current_user.email.split("@")[0].title() if current_user.email else None
        )
        data = record.lease_sheet_data or {}
        site = getattr(record, "site", None)
        client = data.get("customer") or (site.client if site else "") or ""
        area = data.get("area") or (site.area if site else "") or ""
        spray_date_val = record.spray_date
        # record.spray_date is DateTime in the model but often stored as a date. Normalize to date.
        if isinstance(spray_date_val, datetime):
            spray_date_val = spray_date_val.date()
        ticket = TimeMaterialsTicket(
            ticket_number=ticket_number,
            spray_date=spray_date_val,
            client=client,
            area=area,
            description_of_work=description_of_work,
            created_by_user_id=created_by_user_id,
            created_by_name=user_name,
            status=TMTicketStatus.open,
        )
        db.add(ticket)
        db.flush()
        return ticket

    return None
