"""Endpoints for Time & Materials tickets.

Ticket numbers come from the DEDICATED `tm_ticket_seq` (prefix "TM"). Herbicide
lease sheets have their own separate `herb_lease_seq` (prefix "HL") — the two
are fully independent so counts don't interleave. Legacy tickets created before
the split keep their original "T######" numbers.

Workers can only view/edit their own tickets; office/admin see all and can fill office_data.
"""
from datetime import date, datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import and_, or_, text
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
from app.pipeline_models import SprayRecord as PipelineSprayRecord
from app.schemas import (
    TimeMaterialsRowRead,
    TimeMaterialsTicketCreate,
    TimeMaterialsTicketRead,
    TimeMaterialsTicketUpdate,
    TMTicketsDeltaResponse,
)

router = APIRouter(prefix="/api/time-materials", tags=["time-materials"])


# Labels that a worker role is allowed to edit QTY on. Must stay in sync with
# WORKER_EDITABLE_LINE_LABELS in frontend/src/lib/tmTicketPdfGenerator.js.
WORKER_EDITABLE_LINE_LABELS = frozenset({
    "Truck Unit (/hr)",
    "Lead Applicator (/hr)",
    "Assistant Applicator (/hr)",
    "UTV Unit (/day)",
    "Backpack (/day)",
    "H2S Monitors",
    "Travel Km",
})


def _validate_ticket_ready_for_submission(ticket: TimeMaterialsTicket) -> None:
    """Enforce that every worker-required Office Use row has a numeric qty
    before a ticket may transition to `submitted` or `approved`.

    Scope: only the 7 labels in WORKER_EDITABLE_LINE_LABELS (truck, applicators,
    UTV, backpack, H2S monitors, travel km) are required. 0 is acceptable
    ("didn't use this item"); empty/null/non-numeric is rejected. Auto-
    populated lines are derived from the spray rows and don't need checking.
    Custom office-added pricing lines are optional.

    Kept as a server-side backstop \u2014 the frontend also validates (the Submit /
    Approve buttons are gated on this) but a UI-only check is bypassable via
    direct API access.
    """
    lines = (ticket.office_data or {}).get("lines") or []
    missing = []
    # Track which required labels actually APPEAR in the ticket's office_data.
    # A ticket that never had office_data initialised at all will have none
    # of the 7 labels present \u2014 also a submission blocker.
    present_required = set()
    for line in lines:
        label = (line or {}).get("label") or ""
        if label not in WORKER_EDITABLE_LINE_LABELS:
            continue
        present_required.add(label)
        qty = (line or {}).get("qty")
        if qty is None or qty == "":
            missing.append(label)
            continue
        try:
            float(qty)
        except (TypeError, ValueError):
            missing.append(label)
    # Any required label missing from the payload altogether counts as empty.
    for label in WORKER_EDITABLE_LINE_LABELS - present_required:
        missing.append(label)
    if missing:
        # Deterministic ordering for a clean error message.
        ordered = [l for l in WORKER_EDITABLE_LINE_LABELS if l in set(missing)]
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "Cannot submit ticket \u2014 fill in a quantity (0 if unused) for: "
                + ", ".join(ordered)
            ),
        )


def _merge_worker_office_data(
    existing: dict | None,
    incoming: dict | None,
) -> dict | None:
    """Merge a worker-submitted office_data onto the existing ticket office_data.

    Workers never set rates; only QTY on allowlisted labels is accepted as a
    mutation on an already-populated office_data. On the FIRST save from a
    worker (existing is null / has no lines yet), we seed the full shape from
    the incoming payload with rate forced to None on every line — otherwise
    the merge loop below iterates over an empty existing_lines list and
    returns {"lines": []}, silently discarding the worker's typed qtys.
    """
    if incoming is None:
        return existing

    incoming_lines = incoming.get("lines") or []

    # First save: no existing lines yet. Seed the shape from incoming so the
    # 11 default labels (worker-editable + auto-populated + office-only)
    # persist for future reads. rate is FORCED to None on every line —
    # workers never set prices, and rate=None coerces to 0 in
    # computeOfficeTotals on the frontend, so totals render as $0 until
    # office fills rates in on their pricing pass.
    if not (existing and existing.get("lines")):
        seeded = [
            {"label": il.get("label") or "", "qty": il.get("qty"), "rate": None}
            for il in incoming_lines
            if il.get("label")
        ]
        return {
            "lines": seeded,
            "gst_percent": (existing or {}).get("gst_percent", 5),
        }

    # Subsequent saves: merge QTY-only on allowlisted labels, preserve
    # everything else (rate, labels, non-allowlisted lines, gst_percent).
    incoming_qty_by_label = {
        il["label"]: il["qty"]
        for il in incoming_lines
        if il.get("label") in WORKER_EDITABLE_LINE_LABELS and "qty" in il
    }
    existing_lines = list(existing.get("lines") or [])
    existing_labels = set()
    merged_lines = []
    for el in existing_lines:
        lbl = el.get("label") or ""
        existing_labels.add(lbl)
        if lbl in incoming_qty_by_label:
            merged_lines.append({**el, "qty": incoming_qty_by_label[lbl]})
        else:
            merged_lines.append(el)
    # Defensive: if a worker-allowlisted label somehow isn't in existing
    # (e.g. office manually deleted a default line before the worker saved),
    # append it so the worker's typed qty isn't silently dropped.
    for il in incoming_lines:
        lbl = il.get("label") or ""
        if lbl in WORKER_EDITABLE_LINE_LABELS and lbl not in existing_labels:
            merged_lines.append({"label": lbl, "qty": il.get("qty"), "rate": None})

    return {
        "lines": merged_lines,
        "gst_percent": existing.get("gst_percent", 5),
    }


def _strip_office_fields_for_worker(
    ticket: TimeMaterialsTicket, current_user: User
) -> TimeMaterialsTicketRead:
    """Convert a ticket to its Read schema, stripping pricing data for workers.

    Workers can see office_data labels + QTY (so they can verify their entered
    amounts and the auto-populated values), but NOT the rate column, GST rate,
    or totals. Signatures stay hidden too.
    """
    data = TimeMaterialsTicketRead.model_validate(ticket)
    if current_user.role == RoleEnum.worker:
        stripped_office_data = None
        if ticket.office_data:
            # Strip `rate` from every line, keep label + qty.
            stripped_lines = [
                {k: v for k, v in (line or {}).items() if k != "rate"}
                for line in (ticket.office_data.get("lines") or [])
            ]
            stripped_office_data = {"lines": stripped_lines}
        data = data.model_copy(update={
            "office_data": stripped_office_data,
            "approved_signature": None,
        })
    return data


def _worker_owns_ticket(ticket: TimeMaterialsTicket, current_user: User) -> bool:
    """A worker "owns" a ticket if their id matches created_by_user_id, OR —
    for legacy orphaned tickets created before users were persisted — their
    display name matches created_by_name.
    """
    if ticket.created_by_user_id is not None and ticket.created_by_user_id == current_user.id:
        return True
    if ticket.created_by_user_id is None and current_user.name and ticket.created_by_name == current_user.name:
        return True
    return False


def _can_edit_ticket(ticket: TimeMaterialsTicket, current_user: User) -> bool:
    """Workers can only edit their own tickets. Office/admin can edit any."""
    if current_user.role in (RoleEnum.admin, RoleEnum.office):
        return True
    return _worker_owns_ticket(ticket, current_user)


def _visible_query(db: Session, current_user: User, include_deleted: bool = False):
    """Base query scoped to what the current user can see.

    Workers see tickets where (a) created_by_user_id matches their id, OR
    (b) created_by_user_id is NULL but created_by_name matches theirs (covers
    legacy tickets created before users were seeded into the local table).

    `include_deleted=True` is used ONLY by the delta endpoint, which needs
    to see soft-deleted rows to emit their IDs in `ids_removed`. Every other
    caller filters `deleted_at IS NULL` so deleted tickets disappear from
    lists / detail views immediately.
    """
    q = db.query(TimeMaterialsTicket).options(joinedload(TimeMaterialsTicket.rows))
    if not include_deleted:
        q = q.filter(TimeMaterialsTicket.deleted_at.is_(None))
    if current_user.role == RoleEnum.worker:
        q = q.filter(
            or_(
                TimeMaterialsTicket.created_by_user_id == current_user.id,
                and_(
                    TimeMaterialsTicket.created_by_user_id.is_(None),
                    TimeMaterialsTicket.created_by_name == current_user.name,
                ),
            )
        )
    return q


def _allocate_ticket_number(db: Session) -> str:
    """Pull the next TM-prefixed ticket number from the dedicated tm_ticket_seq.

    Uses its own sequence (created by split_ticket_sequences_migration.sql) so
    T&M numbering doesn't interleave with herbicide lease sheets.
    """
    result = db.execute(text("SELECT nextval('tm_ticket_seq')"))
    seq_value = result.scalar()
    return f"TM{seq_value:06d}"


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

    Always scoped to the CURRENT user's own open tickets \u2014 including for office
    and admin. Rationale: when somebody is linking their lease-sheet activity
    to a ticket, they should only pick from tickets they themselves created,
    otherwise hours land on another person's ticket and billing gets muddled.
    Office/admin who need to see everyone's tickets use the main list endpoint
    at `/api/time-materials`, not this picker.
    """
    # NOT _visible_query \u2014 that allows office/admin to see all tickets. The
    # linking picker must always be "mine only" regardless of role.
    q = db.query(TimeMaterialsTicket).options(joinedload(TimeMaterialsTicket.rows)).filter(
        TimeMaterialsTicket.status == TMTicketStatus.open,
        TimeMaterialsTicket.deleted_at.is_(None),
        or_(
            TimeMaterialsTicket.created_by_user_id == current_user.id,
            and_(
                TimeMaterialsTicket.created_by_user_id.is_(None),
                TimeMaterialsTicket.created_by_name == current_user.name,
            ),
        ),
    )
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


# ── Delta ────────────────────────────────────────────────────────
#
# Declared BEFORE the /{ticket_id} route so FastAPI doesn't route "delta"
# as a ticket_id path parameter. Same gotcha as /api/sites/delta.


@router.get("/delta", response_model=TMTicketsDeltaResponse)
def tm_tickets_delta(
    since: datetime = Query(..., description="ISO timestamp from a previous server_time"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Incremental T&M tickets sync — rows whose `updated_at > since`.

    Mirrors `/api/sites/delta` and `/api/pipelines/delta`:
      - `items`: active tickets (deleted_at IS NULL) touched since `since`.
      - `ids_removed`: soft-deleted ticket IDs touched since `since` so the
        frontend can prune its cache.
      - `server_time`: captured BEFORE the query so anything written during
        this request is guaranteed to be caught by the next call.

    Poll loop pairs this with the `tm_tickets_last_updated` watermark in
    `/api/sync-status` so we only hit this endpoint when something actually
    changed — egress stays near zero in the steady state.
    """
    # Capture server_time first so rows written mid-request are caught next tick.
    server_time = datetime.utcnow()

    # include_deleted=True so the same scoped query returns soft-deleted rows
    # for the `ids_removed` pass below; we split active vs removed in Python.
    base = _visible_query(db, current_user, include_deleted=True).filter(
        TimeMaterialsTicket.updated_at > since
    )
    rows = base.order_by(TimeMaterialsTicket.updated_at.desc()).limit(500).all()

    items: list[TimeMaterialsTicketRead] = []
    ids_removed: list[int] = []
    for t in rows:
        if t.deleted_at is not None:
            ids_removed.append(t.id)
        else:
            items.append(_strip_office_fields_for_worker(t, current_user))

    return TMTicketsDeltaResponse(
        items=items,
        ids_removed=ids_removed,
        server_time=server_time,
    )


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

    # current_user.id is guaranteed to exist in the local `users` table because
    # auth.get_current_user upserts it on every request. Safe to reference via FK.
    user_name = getattr(current_user, "name", None) or (
        current_user.email.split("@")[0].title() if current_user.email else None
    )

    ticket = TimeMaterialsTicket(
        ticket_number=ticket_number,
        spray_date=payload.spray_date,
        client=payload.client,
        area=payload.area,
        description_of_work=payload.description_of_work,
        created_by_user_id=current_user.id,
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

    # Worker edit window: workers may edit their own ticket while it's
    # `open` (drafting) or `submitted` (handed off, awaiting office review).
    # Once the ticket is `approved`, it's frozen on the worker side \u2014 the
    # only way to re-edit is for office to Unapprove first, which wipes the
    # signature/approval metadata. This guard runs BEFORE any field mutation
    # so even the description_of_work assignment below can't sneak through.
    if not is_office and ticket.status == TMTicketStatus.approved:
        trying_to_edit = any([
            payload.description_of_work is not None,
            payload.office_data is not None,
            payload.status is not None,
            payload.pdf_base64,
            payload.row_updates,
            payload.po_approval_number is not None,
            payload.approved_signature is not None,
            payload.approve,
        ])
        if trying_to_edit:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="This ticket has already been approved \u2014 ask office to unapprove it if edits are needed",
            )

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
            # Transitioning OUT of "approved" (office unapproving a ticket so a
            # worker can correct it, or so office can re-sign) — wipe the
            # approval metadata and signature so the ticket reads as unsigned
            # again and the PDF regenerates clean on next save.
            if (
                ticket.status == TMTicketStatus.approved
                and payload.status != TMTicketStatus.approved
            ):
                ticket.approved_at = None
                ticket.approved_by_user_id = None
                ticket.approved_by_name = None
                ticket.approved_signature = None
            ticket.status = payload.status
        if payload.approved_signature is not None:
            ticket.approved_signature = payload.approved_signature
        if payload.approve:
            # Apply the same 7-field qty-present check as worker submit. If
            # office tries to approve a ticket that's missing worker-filled
            # quantities (e.g. the worker skipped Submit and office is
            # approving a legacy `open` ticket directly), they get the same
            # descriptive 400 listing the missing labels. The frontend also
            # pre-checks so this only fires when someone bypasses the UI.
            #
            # office_data may have just been mutated above \u2014 validate the
            # merged state, not the pre-merge version.
            _validate_ticket_ready_for_submission(ticket)
            ticket.status = TMTicketStatus.approved
            ticket.approved_at = datetime.utcnow()
            # current_user.id is guaranteed-present (auth upserts the user row).
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
        # Worker path: reject approval + office-only write attempts outright,
        # but accept office_data WITH QTY-only merge on allowlisted labels,
        # and allow the one-way open -> submitted status transition so the
        # worker can hand the ticket off to office for pricing & approval.
        # Approval + office-only field attempts always 403 regardless of
        # status. (The "already approved" lockout is handled by the earlier
        # guard that runs before any field mutation.)
        if any([
            payload.po_approval_number is not None,
            payload.approved_signature is not None,
            payload.approve,
        ]):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Office-only fields")

        if payload.office_data is not None:
            ticket.office_data = _merge_worker_office_data(ticket.office_data, payload.office_data)
        if payload.status is not None:
            # Only one legal worker-initiated transition: open -> submitted.
            # Anything else (re-opening, approving, etc.) belongs to office.
            if payload.status != TMTicketStatus.submitted or ticket.status != TMTicketStatus.open:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="Workers can only submit an open ticket for approval",
                )
            # Validate the merged office_data FIRST so the error message points
            # at the qty fields the worker still needs to fill in.
            _validate_ticket_ready_for_submission(ticket)
            ticket.status = TMTicketStatus.submitted
        # Workers cannot update rows (cost_code etc. is office-only); silently ignore.

    # Upload the PDF to Dropbox on any state where the ticket is NOT still
    # open (i.e., has been submitted or approved). This means:
    #   \u2022 Worker submit -> uploads the worker-view PDF so they can open
    #     the Dropbox link from their Recently Submitted list and see their
    #     ticket number + qtys reflected in a stored PDF.
    #   \u2022 Office approve -> overwrites with the finalized priced PDF +
    #     signature.
    #   \u2022 Office interim edits on a submitted/approved ticket also refresh
    #     the Dropbox PDF so it mirrors the latest state.
    # We intentionally skip upload while status is still `open` so draft
    # edits (worker typing qtys, office interim save) don't churn Dropbox.
    if payload.pdf_base64 and ticket.status != TMTicketStatus.open:
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
    ticket = (
        db.query(TimeMaterialsTicket)
        .filter(
            TimeMaterialsTicket.id == ticket_id,
            TimeMaterialsTicket.deleted_at.is_(None),
        )
        .first()
    )
    if not ticket:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Ticket not found")
    # Soft-delete: we stamp `deleted_at` + bump `updated_at` so the row
    # shows up in the next /api/time-materials/delta call with its ID in
    # `ids_removed`. Frontend caches can prune accordingly. We also unlink
    # the spray records here (same as before) so they don't keep pointing
    # at a ticket that's effectively gone.
    now = datetime.utcnow()
    for rec in list(ticket.spray_records):
        rec.tm_ticket_id = None
    for rec in list(ticket.pipeline_spray_records):
        rec.tm_ticket_id = None
    ticket.deleted_at = now
    ticket.updated_at = now
    db.commit()


# ── Row helpers used internally by spray record endpoints ────────

def _to_float(v):
    try:
        return float(v) if v not in (None, "", "___") else None
    except (ValueError, TypeError):
        return None


def _herbicides_text(herb_list: list) -> str:
    n = len(herb_list or [])
    if n == 0:
        return ""
    # Always show a count, even for a single herbicide, so the Sites Treated
    # column reads consistently and lines up 1:1 with the "N Herbicide (m³)"
    # rows in the Office Use ONLY section below.
    # Cap at 3 — jobs with 4+ herbicides still follow the 3-Herbicide pricing
    # workflow on the T&M ticket.
    n = min(n, 3)
    return f"{n} Herbicide" if n == 1 else f"{n} Herbicides"


def _site_type_from_site(site) -> str:
    if site is None:
        return ""
    pin_type = getattr(site, "pin_type", None)
    pin_val = pin_type.value if pin_type is not None and hasattr(pin_type, "value") else pin_type
    type_map = {"lsd": "Wellsite", "water": "Water", "quad_access": "Quad Access", "reclaimed": "Reclaimed"}
    return type_map.get(pin_val, "")


def _is_pipeline_record(record) -> bool:
    """True iff `record` is a pipeline SprayRecord (vs a SiteSprayRecord).

    The two share almost the same shape (lease_sheet_data, spray_date,
    is_avoided, etc.) but come from different tables with different parent
    objects (`record.site` vs `record.pipeline`) and different FK columns on
    TimeMaterialsRow. All row-derivation helpers branch on this.
    """
    return isinstance(record, PipelineSprayRecord)


def derive_row_from_spray_record(record) -> dict:
    """Derive the MAIN T&M row fields from a spray record's lease_sheet_data.

    Works for both SiteSprayRecord and pipeline SprayRecord. Three cases for
    site_type, in priority order:

    1. Lease sheet has `isPipeline=True` (worker ticked a pipeline-flagged
       location type): site_type='Pipeline', and the area_ha column carries
       `totalDistanceSprayed / 1000` (km) rather than hectares — same column
       reuse trick the Roadside companion row uses. Rendered as 'km' in the
       PDF / detail view.
    2. Pipeline spray record (came in via a pipeline pin) with no isPipeline
       flag: fall back to site_type='Pipeline' with the usual hectare area,
       so existing rows keep rendering sensibly.
    3. Site spray record: site_type derived from the site's pin_type.
    """
    data = record.lease_sheet_data or {}
    is_pipeline_sheet = bool(data.get("isPipeline"))
    if is_pipeline_sheet:
        # Prefer pipeline.name for pipeline records, fall back to site.lsd
        # for the rare case where a worker tags 'Pipeline' from a site pin.
        pipeline = getattr(record, "pipeline", None)
        site = getattr(record, "site", None)
        location = (
            data.get("lsdOrPipeline")
            or (pipeline.name if pipeline else None)
            or (site.lsd if site else None)
        )
        # totalDistanceSprayed is stored in km for pipeline lease sheets
        # (single unit end-to-end: UI form, lease-sheet PDF, T&M row, T&M
        # PDF all agree). Reuse the area_ha column as the km carrier — same
        # trick the Roadside companion row uses with roadsideKm.
        return {
            "location": location,
            "site_type": "Pipeline",
            "herbicides": _herbicides_text(data.get("herbicidesUsed") or []),
            "liters_used": _to_float(data.get("totalLiters")),
            "area_ha": _to_float(data.get("totalDistanceSprayed")),
        }
    if _is_pipeline_record(record):
        pipeline = getattr(record, "pipeline", None)
        location = data.get("lsdOrPipeline") or (pipeline.name if pipeline else None)
        site_type = "Pipeline"
    else:
        site = getattr(record, "site", None)
        location = data.get("lsdOrPipeline") or (site.lsd if site else None)
        site_type = _site_type_from_site(site)
    return {
        "location": location,
        "site_type": site_type,
        "herbicides": _herbicides_text(data.get("herbicidesUsed") or []),
        "liters_used": _to_float(data.get("totalLiters")),
        "area_ha": _to_float(data.get("areaTreated")),
    }


def _has_roadside(data: dict) -> bool:
    """True if the lease sheet's locationTypes include an access-road entry OR
    roadsideLiters/roadsideKm were actually filled in."""
    if data.get("isAccessRoad"):
        return True
    if _to_float(data.get("roadsideLiters")) or _to_float(data.get("roadsideKm")):
        return True
    return False


def derive_roadside_row_from_spray_record(record) -> dict | None:
    """Derive a second 'Roadside' T&M row from a lease sheet if applicable.

    The roadside row uses `area_ha` to store the roadsideKm value (unit is
    swapped to 'km' at render time by inspecting site_type == 'Roadside').
    Supports both site and pipeline spray records.
    """
    data = record.lease_sheet_data or {}
    if not _has_roadside(data):
        return None
    if _is_pipeline_record(record):
        pipeline = getattr(record, "pipeline", None)
        location = data.get("lsdOrPipeline") or (pipeline.name if pipeline else None)
    else:
        site = getattr(record, "site", None)
        location = data.get("lsdOrPipeline") or (site.lsd if site else None)
    return {
        "location": location,
        "site_type": "Roadside",
        "herbicides": _herbicides_text(data.get("roadsideHerbicides") or []),
        "liters_used": _to_float(data.get("roadsideLiters")),
        "area_ha": _to_float(data.get("roadsideKm")),
    }


def _upsert_row(
    db: Session,
    ticket: TimeMaterialsTicket,
    record,
    fields: dict,
    is_roadside: bool,
) -> TimeMaterialsRow:
    """Upsert a single row keyed by (spray_record_id or
    pipeline_spray_record_id, is_roadside). Roadside vs main is disambiguated
    via site_type == 'Roadside'. Picks the correct FK column based on which
    kind of spray record was passed in.
    """
    is_pipeline = _is_pipeline_record(record)
    fk_col = (
        TimeMaterialsRow.pipeline_spray_record_id if is_pipeline
        else TimeMaterialsRow.spray_record_id
    )
    q = db.query(TimeMaterialsRow).filter(fk_col == record.id)
    if is_roadside:
        q = q.filter(TimeMaterialsRow.site_type == "Roadside")
    else:
        q = q.filter(TimeMaterialsRow.site_type != "Roadside")
    row = q.first()

    if row:
        for k, v in fields.items():
            if v is not None:
                setattr(row, k, v)
        if row.ticket_id != ticket.id:
            row.ticket_id = ticket.id
    else:
        fk_kwargs = (
            {"pipeline_spray_record_id": record.id} if is_pipeline
            else {"spray_record_id": record.id}
        )
        row = TimeMaterialsRow(
            ticket_id=ticket.id,
            **fk_kwargs,
            **fields,
        )
        db.add(row)
    return row


def append_row_for_spray_record(
    db: Session,
    ticket: TimeMaterialsTicket,
    record,
) -> TimeMaterialsRow:
    """Create (or update existing) rows for a spray record on the given ticket.

    Always upserts the main row. If the lease sheet has an access-road portion
    (isAccessRoad or roadside values filled), also upserts a companion
    'Roadside' row so it gets its own line in the Sites Treated table.
    """
    # Main row
    main_fields = derive_row_from_spray_record(record)
    main_row = _upsert_row(db, ticket, record, main_fields, is_roadside=False)

    # Optional roadside row
    roadside_fields = derive_roadside_row_from_spray_record(record)
    if roadside_fields is not None:
        _upsert_row(db, ticket, record, roadside_fields, is_roadside=True)

    record.tm_ticket_id = ticket.id
    ticket.updated_at = datetime.utcnow()
    db.flush()
    return main_row


def find_or_create_ticket_for_link(
    db: Session,
    record,
    link_ticket_id: Optional[int],
    link_create: bool,
    description_of_work: Optional[str],
    current_user: User,
) -> Optional[TimeMaterialsTicket]:
    """Resolve a time_materials_link into a concrete ticket to append the row to."""
    if link_ticket_id is not None:
        ticket = (
            db.query(TimeMaterialsTicket)
            .filter(
                TimeMaterialsTicket.id == link_ticket_id,
                TimeMaterialsTicket.deleted_at.is_(None),
            )
            .first()
        )
        if not ticket:
            return None
        # Cannot attach additional rows to a ticket that is no longer open
        # (submitted / approved / signed). The picker already filters these out
        # on the frontend, but this is a backstop against stale UIs.
        if ticket.status != TMTicketStatus.open:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="T&M ticket is already signed / approved and cannot accept new rows.",
            )
        # Workers may only attach to their own open tickets
        if current_user.role == RoleEnum.worker and not _worker_owns_ticket(ticket, current_user):
            return None
        return ticket

    if link_create:
        ticket_number = _allocate_ticket_number(db)
        user_name = getattr(current_user, "name", None) or (
            current_user.email.split("@")[0].title() if current_user.email else None
        )
        data = record.lease_sheet_data or {}
        # Parent varies by record type: site spray records have `.site`,
        # pipeline spray records have `.pipeline`. Either provides client/area.
        if _is_pipeline_record(record):
            parent = getattr(record, "pipeline", None)
        else:
            parent = getattr(record, "site", None)
        client = data.get("customer") or (parent.client if parent else "") or ""
        area = data.get("area") or (parent.area if parent else "") or ""
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
            created_by_user_id=current_user.id,
            created_by_name=user_name,
            status=TMTicketStatus.open,
        )
        db.add(ticket)
        db.flush()
        return ticket

    return None
