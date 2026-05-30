"""Endpoints for the Hydroseed module — daily field records + billing tickets.

Two new sequence-numbered forms, modeled on the herbicide lease-sheet / T&M flow:
  • HydroseedDailyRecord (HD######) — one per crew per day per site, captures
    tank-load data + materials + equipment hours + seed-tag photos + map
    annotations.
  • HydroseedTicket (HT######) — billing roll-up. Many dailies aggregate into
    one ticket; office prices it and signs. Office-only sees rates/totals on PDF.

Unlike T&M, all qtys on the HT come from rolled-up daily data (workers don't
type qtys onto the ticket), so office_data is office-write-only.
"""
from datetime import date, datetime
from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import and_, or_, text
from sqlalchemy.orm import Session, defer, joinedload

from app.auth import get_current_user, require_roles
from app.database import get_db
from app.models import (
    HydroseedDailyRecord,
    HydroseedTicket,
    HydroseedTicketRow,
    RoleEnum,
    TMTicketStatus,
    User,
)
from app.schemas import (
    HydroseedDailyCreate,
    HydroseedDailyDeltaResponse,
    HydroseedDailyListRead,
    HydroseedDailyRead,
    HydroseedDailyUpdate,
    HydroseedTicketCreate,
    HydroseedTicketDeltaRow,
    HydroseedTicketRead,
    HydroseedTicketsDeltaResponse,
    HydroseedTicketUpdate,
)

router = APIRouter(prefix="/api/hydroseed", tags=["hydroseed"])


# ── Constants ────────────────────────────────────────────────────────────────

KG_PER_BALE = Decimal("22.7")  # one bale of mulch = 22.7 kg (worker-confirmed)


# ── Sequences ────────────────────────────────────────────────────────────────

def _allocate_daily_number(db: Session) -> str:
    seq_value = db.execute(text("SELECT nextval('hydroseed_daily_seq')")).scalar()
    return f"HD{seq_value:06d}"


def _allocate_ticket_number(db: Session) -> str:
    seq_value = db.execute(text("SELECT nextval('hydroseed_ticket_seq')")).scalar()
    return f"HT{seq_value:06d}"


# ── Visibility helpers ──────────────────────────────────────────────────────

def _worker_owns_ticket(ticket: HydroseedTicket, current_user: User) -> bool:
    if ticket.created_by_user_id is not None and ticket.created_by_user_id == current_user.id:
        return True
    if ticket.created_by_user_id is None and current_user.name and ticket.created_by_name == current_user.name:
        return True
    return False


def _worker_owns_daily(daily: HydroseedDailyRecord, current_user: User) -> bool:
    if daily.created_by_user_id is not None and daily.created_by_user_id == current_user.id:
        return True
    if daily.created_by_user_id is None and current_user.name and daily.created_by_name == current_user.name:
        return True
    return False


def _visible_tickets_query(db: Session, current_user: User, include_deleted: bool = False):
    # Full query: eager-loads rows + daily_records (with daily_data for the
    # HydroseedLinkedDaily validator). Used only by get_ticket (single-record
    # fetch) where the detail sheet needs linked daily scalars.
    q = db.query(HydroseedTicket).options(
        joinedload(HydroseedTicket.rows),
        joinedload(HydroseedTicket.daily_records).options(
            defer(HydroseedDailyRecord.photo_urls),
            defer(HydroseedDailyRecord.seed_tag_photo_urls),
        ),
    )
    if not include_deleted:
        q = q.filter(HydroseedTicket.deleted_at.is_(None))
    if current_user.role == RoleEnum.worker:
        q = q.filter(
            or_(
                HydroseedTicket.created_by_user_id == current_user.id,
                and_(
                    HydroseedTicket.created_by_user_id.is_(None),
                    HydroseedTicket.created_by_name == current_user.name,
                ),
            )
        )
    return q


def _slim_tickets_query(db: Session, current_user: User, include_deleted: bool = False):
    # Slim query: loads rows but NOT daily_records. Used by list endpoints
    # (list_tickets, list_open_tickets, tickets_delta) where the UI only
    # needs ticket header + row summaries — skipping the daily_records
    # joinedload avoids pulling daily_data JSONB for every linked daily,
    # which caused 30-second list load times as the dataset grew.
    q = db.query(HydroseedTicket).options(
        joinedload(HydroseedTicket.rows),
    )
    if not include_deleted:
        q = q.filter(HydroseedTicket.deleted_at.is_(None))
    if current_user.role == RoleEnum.worker:
        q = q.filter(
            or_(
                HydroseedTicket.created_by_user_id == current_user.id,
                and_(
                    HydroseedTicket.created_by_user_id.is_(None),
                    HydroseedTicket.created_by_name == current_user.name,
                ),
            )
        )
    return q


def _visible_dailies_query(db: Session, current_user: User, include_deleted: bool = False):
    q = db.query(HydroseedDailyRecord)
    if not include_deleted:
        q = q.filter(HydroseedDailyRecord.deleted_at.is_(None))
    if current_user.role == RoleEnum.worker:
        q = q.filter(
            or_(
                HydroseedDailyRecord.created_by_user_id == current_user.id,
                and_(
                    HydroseedDailyRecord.created_by_user_id.is_(None),
                    HydroseedDailyRecord.created_by_name == current_user.name,
                ),
            )
        )
    return q


def _strip_office_fields_for_worker(
    ticket: HydroseedTicket, current_user: User
) -> HydroseedTicketRead:
    """Hide pricing-bearing office fields from worker payloads.

    The paper-form HT PDF has counts, comments, and "other product" labels in
    the same combined table as the priced rate lines. Workers should still
    see the descriptive non-price fields so the PDF preview is meaningful to
    them — only `rate`, GST/percent, and totals get stripped.
    """
    data = HydroseedTicketRead.model_validate(ticket)
    if current_user.role == RoleEnum.worker:
        stripped_office_data = None
        if ticket.office_data:
            src = ticket.office_data
            # Lines: keep label + qty + unit, strip only `rate`.
            stripped_lines = [
                {k: v for k, v in (line or {}).items() if k != "rate"}
                for line in (src.get("lines") or [])
            ]
            # Other products: same — keep label + qty + unit, strip only `rate`.
            stripped_other_products = [
                {k: v for k, v in (op or {}).items() if k != "rate"}
                for op in (src.get("other_products") or [])
            ]
            stripped_office_data = {
                "lines": stripped_lines,
                "comments": src.get("comments"),
                "other_products": stripped_other_products,
            }
            # Drop None/empty so the worker payload stays slim.
            stripped_office_data = {
                k: v for k, v in stripped_office_data.items()
                if v not in (None, [], "")
            }
            if not stripped_office_data:
                stripped_office_data = None
        data = data.model_copy(update={
            "office_data": stripped_office_data,
            "approved_signature": None,
        })
    return data


# ── Aggregation: roll up a daily's loads into HydroseedTicketRows ───────────

def _to_decimal(v) -> Decimal:
    if v is None or v == "":
        return Decimal(0)
    try:
        return Decimal(str(v))
    except Exception:
        return Decimal(0)


def _aggregate_rows_from_daily(daily: HydroseedDailyRecord) -> list[dict]:
    """Roll up daily.daily_data.loads + .equipment + payroll fields into
    ticket-row dicts.

    Returns one row per non-zero (kind, label, unit) triple. The HT PDF
    generator sums these across all linked dailies for the ticket's totals
    table; this function is the per-daily contribution.

    Per-seed-type rows: each declared seed type emits its own row labelled
    'Seed: <name>' so the HT PDF can split them into '#1 Seed' / '#2 Seed'
    slots in the paper-form schedule. A combined 'Seed' row is also emitted
    for backward compatibility with anything that consumes the rolled-up
    rows directly.

    Mulch: emits BOTH a kg row AND a separate 'Mulch (bales)' row so the
    paper-form 'Mulch (bales used. N)' label can render the bale count
    inline without re-deriving from KG_PER_BALE.

    Labour: emits up to 3 rows from the daily's payroll fields:
      - 'Supervisor'         qty = supervisor_hours
      - 'Lead Hand'          qty = lead_hours
      - 'Total General Labour' qty = labour_hours_per_person × workers.length
        with cost_code = 'per_person=<H>;count=<N>' so the PDF can show
        '<N> # of Labourers on site' inline alongside the total hours.

    Crew Truck: emits 'Crew Truck' equipment row from the new
    crew_truck_count × crew_truck_hours fields, with cost_code carrying
    the per-truck-hours and count for the paper-form '<N> # trucks on
    site' annotation.

    Travel + Water Truck: emit 'Travel (Mob/Demob)' (unit=km) and
    'Water Truck' (unit=loads) when present.

    Equipment[] entries are passed through as-is so existing flows
    (e.g. multiple hydroseeders rendered as separate rows) keep working.
    """
    data = daily.daily_data or {}
    loads = data.get("loads") or []
    equipment = data.get("equipment") or []

    rows: list[dict] = []

    # ── Material totals across all loads on this daily ─────────────────────
    total_area_m2 = Decimal(0)
    total_mulch_kg = Decimal(0)
    total_mulch_bales = Decimal(0)
    total_soil_amend_kg = Decimal(0)
    total_seed_kg = Decimal(0)
    seed_kg_by_name: dict[str, Decimal] = {}
    total_aqua_gel_kg = Decimal(0)
    total_tackifier_kg = Decimal(0)
    total_fertilizer_kg = Decimal(0)
    # Per-load liquid additive measured in litres. Workers enter it on
    # each load via the load editor; the HT PDF rolls these up into a
    # single 'Micronutrients' line in the materials/installation table.
    total_micronutrients_l = Decimal(0)

    for load in loads:
        total_area_m2 += _to_decimal(load.get("area_m2"))
        bales = _to_decimal(load.get("mulch_bales"))
        total_mulch_bales += bales
        total_mulch_kg += bales * KG_PER_BALE
        total_soil_amend_kg += _to_decimal(load.get("soil_amendment_kg"))
        total_aqua_gel_kg += _to_decimal(load.get("aqua_gel_kg"))
        total_tackifier_kg += _to_decimal(load.get("tackifier_kg"))
        total_fertilizer_kg += _to_decimal(load.get("fertilizer_kg"))
        total_micronutrients_l += _to_decimal(load.get("micronutrients_l"))
        # seed_kgs is a dict {seed_type_name: kg}
        seed_kgs = load.get("seed_kgs") or {}
        for name, v in seed_kgs.items():
            qty = _to_decimal(v)
            total_seed_kg += qty
            if name:
                seed_kg_by_name[name] = seed_kg_by_name.get(name, Decimal(0)) + qty

    material_rows = [
        ("Mulch", total_mulch_kg, "kg"),
        ("Mulch (bales)", total_mulch_bales, "bales"),
        ("Soil Amendment", total_soil_amend_kg, "kg"),
        ("Seed", total_seed_kg, "kg"),
        ("Aqua Gel", total_aqua_gel_kg, "kg"),
        ("Tackifier", total_tackifier_kg, "kg"),
        ("Fertilizer", total_fertilizer_kg, "kg"),
        ("Micro Nutrients", total_micronutrients_l, "L"),
        ("Area covered", total_area_m2, "m²"),
    ]
    for label, qty, unit in material_rows:
        if qty and qty != 0:
            rows.append({"kind": "material", "label": label, "qty": float(qty), "unit": unit})

    # Per-seed-type rows so the HT PDF can fill #1 Seed / #2 Seed slots.
    # `cost_code` carries the declared-order index (0-based) so the PDF can
    # match seed names back to their position even if the worker reordered
    # the seed_types list between dailies on the same ticket.
    #
    # The daily form keeps `seed_kgs` keyed by the placeholder `name`
    # ("Seed 1", "Seed 2") so multiple loads can stack on the same seed
    # type even before the worker fills in a description. But the HT PDF
    # needs the human-readable blend (e.g. "ESC Mixture") in its row
    # label so the office + client can tell the seeds apart. We resolve
    # `name` -> `description` via the daily's declared `seed_types[]`
    # and fall back to the placeholder name when a description is blank
    # (or when older data only has names).
    seed_types_decl = data.get("seed_types") or []
    declared_order = {(st.get("name") or ""): idx for idx, st in enumerate(seed_types_decl)}
    seed_descriptions = {
        (st.get("name") or ""): (st.get("description") or "").strip()
        for st in seed_types_decl
    }
    for name, qty in seed_kg_by_name.items():
        if not qty:
            continue
        idx = declared_order.get(name)
        display_name = seed_descriptions.get(name) or name
        rows.append({
            "kind": "material",
            "label": f"Seed: {display_name}",
            "qty": float(qty),
            "unit": "kg",
            "cost_code": f"seed_idx={idx}" if idx is not None else None,
        })

    # ── Equipment hours (daily-level) ──────────────────────────────────────
    for eq in equipment:
        label = (eq or {}).get("label") or ""
        hours = _to_decimal((eq or {}).get("hours"))
        if not label or not hours:
            continue
        # Skip equipment entries that are handled by dedicated structured fields
        # to prevent double-billing / duplicate lines on the ticket.
        if label.lower().strip() in ("crew truck", "travel (mob/demob)", "water truck"):
            continue
        rows.append({
            "kind": "equipment",
            "label": label,
            "qty": float(hours),
            "unit": "hr",
        })

    # ── Crew Truck (count × hours, paper-form style) ───────────────────────
    crew_truck_count = _to_decimal(data.get("crew_truck_count"))
    crew_truck_hours_per = _to_decimal(data.get("crew_truck_hours"))
    crew_truck_total = crew_truck_count * crew_truck_hours_per
    if crew_truck_total and crew_truck_total != 0:
        rows.append({
            "kind": "equipment",
            "label": "Crew Truck",
            "qty": float(crew_truck_total),
            "unit": "hr",
            "cost_code": f"per_unit={crew_truck_hours_per};count={crew_truck_count}",
        })

    # ── Labour (per-role from payroll-hours fields on the daily) ───────────
    supervisor_hours = _to_decimal(data.get("supervisor_hours"))
    if supervisor_hours and supervisor_hours != 0:
        rows.append({
            "kind": "labour",
            "label": "Supervisor",
            "qty": float(supervisor_hours),
            "unit": "hr",
        })
    lead_hours = _to_decimal(data.get("lead_hours"))
    if lead_hours and lead_hours != 0:
        rows.append({
            "kind": "labour",
            "label": "Lead Hand",
            "qty": float(lead_hours),
            "unit": "hr",
        })
    labour_per_person = _to_decimal(data.get("labour_hours_per_person"))
    workers_count = len(data.get("workers") or [])
    labour_total = labour_per_person * workers_count
    if labour_total and labour_total != 0:
        rows.append({
            "kind": "labour",
            "label": "Total General Labour",
            "qty": float(labour_total),
            "unit": "hr",
            "cost_code": f"per_person={labour_per_person};count={workers_count}",
        })

    # ── Travel + Water Truck scalars ───────────────────────────────────────
    travel_km = _to_decimal(data.get("travel_km"))
    if travel_km and travel_km != 0:
        rows.append({
            "kind": "equipment",
            "label": "Travel (Mob/Demob)",
            "qty": float(travel_km),
            "unit": "km",
        })
    water_truck_loads = _to_decimal(data.get("water_truck_loads"))
    if water_truck_loads and water_truck_loads != 0:
        rows.append({
            "kind": "equipment",
            "label": "Water Truck",
            "qty": float(water_truck_loads),
            "unit": "loads",
        })

    return rows


def _resync_ticket_rows_for_daily(
    db: Session, daily: HydroseedDailyRecord, ticket: HydroseedTicket | None
) -> None:
    """Refresh `ticket`'s rolled-up rows for this daily.

    Deletes any prior rows where `daily_record_id == daily.id` (across the
    daily's old AND new tickets if they differ), then inserts fresh ones on
    the target ticket. Called from submit + edit + ticket-link changes.
    """
    # Always clean up old rows for this daily (might be on a different ticket
    # than the new one if the worker re-linked).
    db.query(HydroseedTicketRow).filter(
        HydroseedTicketRow.daily_record_id == daily.id,
    ).delete(synchronize_session=False)

    if ticket is None:
        return

    for row_data in _aggregate_rows_from_daily(daily):
        db.add(HydroseedTicketRow(
            ticket_id=ticket.id,
            daily_record_id=daily.id,
            **row_data,
        ))

    ticket.updated_at = datetime.utcnow()


# ── Dropbox upload helpers ──────────────────────────────────────────────────

def _upload_daily_pdf(
    daily: HydroseedDailyRecord, pdf_base64: str
) -> Optional[str]:
    import base64 as b64
    from app.dropbox_integration import build_hydroseed_daily_path, upload_pdf_to_dropbox

    try:
        pdf_content = b64.b64decode(pdf_base64)
        path = build_hydroseed_daily_path(
            date_str=str(daily.work_date),
            client=daily.client or "",
            area=daily.area or "",
            record=daily.record_number or "",
            site_name=daily.site_name or "",
        )
        return upload_pdf_to_dropbox(pdf_content, path)
    except Exception as e:
        print(f"[HYDROSEED] Error uploading daily PDF: {e}")
        return None


def _upload_ticket_pdf(
    ticket: HydroseedTicket, pdf_base64: str
) -> Optional[str]:
    import base64 as b64
    from app.dropbox_integration import build_hydroseed_ticket_path, upload_pdf_to_dropbox

    try:
        pdf_content = b64.b64decode(pdf_base64)
        path = build_hydroseed_ticket_path(
            date_str=str(ticket.work_date),
            client=ticket.client or "",
            area=ticket.area or "",
            ticket=ticket.ticket_number or "",
        )
        return upload_pdf_to_dropbox(pdf_content, path)
    except Exception as e:
        print(f"[HYDROSEED] Error uploading ticket PDF: {e}")
        return None


def _build_photo_jobs(
    record_number: str, photos: list[dict], prefix: str = ""
) -> list[tuple[bytes, str]]:
    """Decode {data, type} base64 photos and pair them with their Dropbox
    paths. Skips entries with empty `data`. Used to assemble a single
    parallel-upload batch in the create/update endpoints below.
    """
    import base64 as b64
    from app.dropbox_integration import build_photo_path

    jobs: list[tuple[bytes, str]] = []
    for i, photo_data in enumerate(photos or []):
        try:
            data_b64 = (photo_data or {}).get("data") or ""
            if not data_b64:
                continue
            content = b64.b64decode(data_b64)
            label = f"{prefix}{record_number}" if prefix else record_number
            path = build_photo_path(label, i + 1)
            jobs.append((content, path))
        except Exception as e:
            print(f"[HYDROSEED] Error decoding photo {i+1}: {e}")
    return jobs


def _upload_photos(record_number: str, photos: list[dict], prefix: str = "") -> list[str]:
    """Upload a list of {data, type} base64 photos to Dropbox concurrently.

    `prefix` differentiates seed-tag photos from map/annotation photos in the
    Dropbox filename so admins can scan the folder and tell them apart.
    """
    from app.dropbox_integration import upload_files_parallel

    jobs = _build_photo_jobs(record_number, photos, prefix)
    if not jobs:
        return []
    results = upload_files_parallel(jobs)
    return [u for u in results if u]


def _strip_photo_bytes_from_daily_data(data: dict | None) -> dict | None:
    """Mirror of `_strip_photos_from_lease_data` — keep metadata, drop base64
    bytes so the DB row stays small (photos are in Dropbox + photo_urls)."""
    if not data:
        return data
    out = {**data}
    for key in ("photos", "seed_tag_photos"):
        photos = out.get(key)
        if isinstance(photos, list):
            out[key] = [
                {k: v for k, v in (p or {}).items() if k != "data"}
                for p in photos
            ]
    return out


# ── Ticket link resolution ──────────────────────────────────────────────────

def _find_or_create_ticket_for_daily(
    db: Session,
    daily: HydroseedDailyRecord,
    link_ticket_id: Optional[int],
    link_create: bool,
    description_of_work: Optional[str],
    current_user: User,
) -> Optional[HydroseedTicket]:
    """Resolve the daily's hydroseed_ticket_link into a concrete ticket."""
    if link_ticket_id is not None:
        ticket = (
            db.query(HydroseedTicket)
            .filter(
                HydroseedTicket.id == link_ticket_id,
                HydroseedTicket.deleted_at.is_(None),
            )
            .first()
        )
        if not ticket:
            return None
        if ticket.status != TMTicketStatus.open:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Hydroseed ticket is already signed / approved and cannot accept new dailies.",
            )
        if current_user.role == RoleEnum.worker and not _worker_owns_ticket(ticket, current_user):
            return None
        return ticket

    if link_create:
        user_name = getattr(current_user, "name", None) or (
            current_user.email.split("@")[0].title() if current_user.email else None
        )
        ticket_number = _allocate_ticket_number(db)
        work_date_val = daily.work_date
        if isinstance(work_date_val, datetime):
            work_date_val = work_date_val.date()
        ticket = HydroseedTicket(
            ticket_number=ticket_number,
            work_date=work_date_val,
            client=daily.client or "",
            area=daily.area or "",
            description_of_work=description_of_work or daily.description_of_work,
            created_by_user_id=current_user.id,
            created_by_name=user_name,
            status=TMTicketStatus.open,
        )
        db.add(ticket)
        db.flush()
        return ticket

    return None


# ════════════════════════════════════════════════════════════════════════════
# DAILY RECORDS
# ════════════════════════════════════════════════════════════════════════════


# ── Next-number previews ────────────────────────────────────────────────────

@router.get("/next-daily")
def next_daily_number(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Preview the next HD###### number. Frontend shows it on the form before
    submit, like /api/next-ticket. The sequence isn't consumed here."""
    # nextval would consume; use last_value+1 read-only.
    result = db.execute(text(
        "SELECT last_value, is_called FROM hydroseed_daily_seq"
    )).first()
    if not result:
        return {"record_number": "HD000001"}
    last_value, is_called = result
    next_val = last_value + 1 if is_called else last_value
    return {"record_number": f"HD{next_val:06d}"}


@router.get("/next-ticket")
def next_ticket_number(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = db.execute(text(
        "SELECT last_value, is_called FROM hydroseed_ticket_seq"
    )).first()
    if not result:
        return {"ticket_number": "HT000001"}
    last_value, is_called = result
    next_val = last_value + 1 if is_called else last_value
    return {"ticket_number": f"HT{next_val:06d}"}


# ── Latest daily for the current user (duplicate-prompt source) ─────────────

@router.get("/dailies/me/latest", response_model=HydroseedDailyRead | None)
def get_my_latest_daily(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Most recent non-deleted daily for the current user (by work_date desc).
    Used by the duplicate prompt on form open. Returns null when the user has
    no prior dailies — the form just hides the prompt."""
    q = (
        db.query(HydroseedDailyRecord)
        .filter(
            HydroseedDailyRecord.deleted_at.is_(None),
            or_(
                HydroseedDailyRecord.created_by_user_id == current_user.id,
                and_(
                    HydroseedDailyRecord.created_by_user_id.is_(None),
                    HydroseedDailyRecord.created_by_name == current_user.name,
                ),
            ),
        )
        .order_by(HydroseedDailyRecord.work_date.desc(), HydroseedDailyRecord.created_at.desc())
        .limit(1)
    )
    daily = q.first()
    if daily is None:
        return None
    return HydroseedDailyRead.model_validate(daily)


# ── List / detail ────────────────────────────────────────────────────────────

@router.get("/dailies", response_model=list[HydroseedDailyListRead])
def list_dailies(
    work_date: date | None = Query(default=None),
    client: str | None = Query(default=None),
    area: str | None = Query(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # EGRESS: defer the heavy daily_data JSONB blob + photo URL arrays.
    # The list view only renders scalar header columns; the full record
    # is fetched on demand via GET /api/hydroseed/dailies/{id} when the
    # user taps Edit or Duplicate.
    q = _visible_dailies_query(db, current_user).options(
        defer(HydroseedDailyRecord.daily_data),
        defer(HydroseedDailyRecord.photo_urls),
        defer(HydroseedDailyRecord.seed_tag_photo_urls),
    )
    if work_date:
        q = q.filter(HydroseedDailyRecord.work_date == work_date)
    if client:
        q = q.filter(HydroseedDailyRecord.client == client)
    if area:
        q = q.filter(HydroseedDailyRecord.area == area)
    dailies = q.order_by(HydroseedDailyRecord.created_at.desc()).limit(200).all()
    return [HydroseedDailyListRead.model_validate(d) for d in dailies]


# Declared BEFORE /dailies/{id} so FastAPI doesn't route 'deleted' as an id.
@router.get("/dailies/deleted", response_model=list[HydroseedDailyListRead])
def list_deleted_dailies(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_roles(RoleEnum.admin, RoleEnum.office)),
):
    """List soft-deleted hydroseed dailies (admin/office only). Used by
    AdminPanel → Recent Deletes. Slim payload — daily_data deferred."""
    dailies = (
        db.query(HydroseedDailyRecord)
        .options(
            defer(HydroseedDailyRecord.daily_data),
            defer(HydroseedDailyRecord.photo_urls),
            defer(HydroseedDailyRecord.seed_tag_photo_urls),
        )
        .filter(HydroseedDailyRecord.deleted_at.isnot(None))
        .order_by(HydroseedDailyRecord.deleted_at.desc())
        .limit(500)
        .all()
    )
    return [HydroseedDailyListRead.model_validate(d) for d in dailies]


# Declared BEFORE /dailies/{id} so FastAPI doesn't route 'delta' as an id.
@router.get("/dailies/delta", response_model=HydroseedDailyDeltaResponse)
def dailies_delta(
    since: datetime = Query(..., description="ISO timestamp from a previous server_time"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    server_time = datetime.utcnow()
    # Slim payload — defer the heavy daily_data JSONB blob + photo URL
    # arrays. The delta endpoint feeds the FormsPanel list cache; full
    # records are fetched on demand for edit/duplicate.
    base = _visible_dailies_query(db, current_user, include_deleted=True).options(
        defer(HydroseedDailyRecord.daily_data),
        defer(HydroseedDailyRecord.photo_urls),
        defer(HydroseedDailyRecord.seed_tag_photo_urls),
    ).filter(
        HydroseedDailyRecord.updated_at > since
    )
    rows = base.order_by(HydroseedDailyRecord.updated_at.desc()).limit(500).all()
    items: list[HydroseedDailyListRead] = []
    ids_removed: list[int] = []
    for d in rows:
        if d.deleted_at is not None:
            ids_removed.append(d.id)
        else:
            items.append(HydroseedDailyListRead.model_validate(d))
    return HydroseedDailyDeltaResponse(items=items, ids_removed=ids_removed, server_time=server_time)


@router.get("/dailies/{daily_id}", response_model=HydroseedDailyRead)
def get_daily(
    daily_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    daily = _visible_dailies_query(db, current_user).filter(
        HydroseedDailyRecord.id == daily_id
    ).first()
    if not daily:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Daily not found")
    return HydroseedDailyRead.model_validate(daily)


# ── Create ──────────────────────────────────────────────────────────────────

@router.post("/dailies", response_model=HydroseedDailyRead, status_code=status.HTTP_201_CREATED)
def create_daily(
    payload: HydroseedDailyCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Submit a daily. Allocates HD######, uploads PDF + photos, optionally
    links to an HT ticket (existing or create-new) and rolls rows into it."""
    # Idempotency check
    if payload.client_submission_id:
        existing = (
            db.query(HydroseedDailyRecord)
            .filter(
                HydroseedDailyRecord.client_submission_id == payload.client_submission_id,
                HydroseedDailyRecord.deleted_at.is_(None),
            )
            .first()
        )
        if existing is not None:
            return HydroseedDailyRead.model_validate(existing)

    user_id = current_user.id if current_user.id else None
    user_name = getattr(current_user, "name", None) or (
        current_user.email.split("@")[0].title() if current_user.email else None
    )

    record_number = _allocate_daily_number(db)

    daily = HydroseedDailyRecord(
        record_number=record_number,
        work_date=payload.work_date,
        client=payload.client,
        area=payload.area,
        site_name=payload.site_name,
        description_of_work=payload.description_of_work,
        mulch_type=payload.mulch_type,
        comments=payload.comments,
        # daily_data is stripped of base64 bytes before persistence below
        daily_data=None,
        site_id=payload.site_id,
        latitude=payload.latitude,
        longitude=payload.longitude,
        created_by_user_id=user_id,
        created_by_name=user_name,
        client_submission_id=payload.client_submission_id,
        photo_urls=[],
        seed_tag_photo_urls=[],
    )
    db.add(daily)
    db.flush()

    # ── Bundle PDF + ann photos + seed-tag photos into ONE parallel batch ─
    # A daily with 6 ann photos + 4 seed-tag photos + the PDF was 11
    # serial Dropbox round-trips (~15 s) before; one parallel batch
    # finishes in ~3 s. Order in the jobs list is PDF → ann → seed so we
    # can split the results back into their three target columns.
    import base64 as b64
    from app.dropbox_integration import upload_files_parallel, build_hydroseed_daily_path

    photos_input = payload.photos or (payload.daily_data or {}).get("photos") or []
    seed_tag_input = payload.seed_tag_photos or (payload.daily_data or {}).get("seed_tag_photos") or []

    ann_jobs = _build_photo_jobs(record_number, photos_input, prefix="ann_")
    seed_jobs = _build_photo_jobs(record_number, seed_tag_input, prefix="seed_")

    pdf_job: Optional[tuple[bytes, str]] = None
    if payload.pdf_base64:
        try:
            pdf_content = b64.b64decode(payload.pdf_base64)
            pdf_path = build_hydroseed_daily_path(
                date_str=str(daily.work_date),
                client=daily.client or "",
                area=daily.area or "",
                record=daily.record_number or "",
                site_name=daily.site_name or "",
            )
            pdf_job = (pdf_content, pdf_path)
        except Exception as e:
            print(f"[HYDROSEED] Error decoding daily PDF base64: {e}")

    batch: list[tuple[bytes, str]] = (
        ([pdf_job] if pdf_job else []) + ann_jobs + seed_jobs
    )
    if batch:
        results = upload_files_parallel(batch)
        cursor = 0
        if pdf_job:
            if results[cursor]:
                daily.pdf_url = results[cursor]
            cursor += 1
        daily.photo_urls = [u for u in results[cursor:cursor + len(ann_jobs)] if u]
        cursor += len(ann_jobs)
        daily.seed_tag_photo_urls = [u for u in results[cursor:cursor + len(seed_jobs)] if u]

    # Stamp record_number into the daily_data snapshot so re-render shows it.
    if payload.daily_data is not None:
        snapshot = {**payload.daily_data, "record_number": record_number}
    else:
        snapshot = {"record_number": record_number}
    daily.daily_data = _strip_photo_bytes_from_daily_data(snapshot)

    # ── HT linking ────────────────────────────────────────────────────────
    link = payload.hydroseed_ticket_link
    if link and (link.ticket_id is not None or link.create):
        ticket = _find_or_create_ticket_for_daily(
            db=db,
            daily=daily,
            link_ticket_id=link.ticket_id,
            link_create=link.create,
            description_of_work=link.description_of_work,
            current_user=current_user,
        )
        if ticket is not None:
            daily.hydroseed_ticket_id = ticket.id
            _resync_ticket_rows_for_daily(db, daily, ticket)

    db.commit()
    db.refresh(daily)
    return HydroseedDailyRead.model_validate(daily)


# ── Update ──────────────────────────────────────────────────────────────────

@router.patch("/dailies/{daily_id}", response_model=HydroseedDailyRead)
def update_daily(
    daily_id: int,
    payload: HydroseedDailyUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    daily = db.query(HydroseedDailyRecord).filter(
        HydroseedDailyRecord.id == daily_id,
        HydroseedDailyRecord.deleted_at.is_(None),
    ).first()
    if not daily:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Daily not found")

    is_office = current_user.role in (RoleEnum.admin, RoleEnum.office)
    if not is_office and not _worker_owns_daily(daily, current_user):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not allowed")

    # Header fields
    for fld in ("work_date", "client", "area", "site_name", "description_of_work",
                "mulch_type", "comments"):
        val = getattr(payload, fld)
        if val is not None:
            setattr(daily, fld, val)

    # ── Bundle every Dropbox upload that's actually present on this PATCH
    #    into ONE parallel batch. Edits where the worker tweaked a comment
    #    but didn't re-upload anything skip this entirely (`batch == []`).
    #    Edits that re-uploaded photos + a fresh PDF go up in parallel
    #    instead of three serial waves. Same shape as create_hydroseed_daily.
    import base64 as b64
    from app.dropbox_integration import upload_files_parallel, build_hydroseed_daily_path

    ann_jobs = (
        _build_photo_jobs(daily.record_number, payload.photos, prefix="ann_")
        if payload.photos is not None else []
    )
    seed_jobs = (
        _build_photo_jobs(daily.record_number, payload.seed_tag_photos, prefix="seed_")
        if payload.seed_tag_photos is not None else []
    )
    has_ann = payload.photos is not None
    has_seed = payload.seed_tag_photos is not None

    pdf_job: Optional[tuple[bytes, str]] = None
    if payload.pdf_base64:
        try:
            pdf_content = b64.b64decode(payload.pdf_base64)
            pdf_path = build_hydroseed_daily_path(
                date_str=str(daily.work_date),
                client=daily.client or "",
                area=daily.area or "",
                record=daily.record_number or "",
                site_name=daily.site_name or "",
            )
            pdf_job = (pdf_content, pdf_path)
        except Exception as e:
            print(f"[HYDROSEED] Error decoding daily PDF base64: {e}")

    batch: list[tuple[bytes, str]] = (
        ([pdf_job] if pdf_job else []) + ann_jobs + seed_jobs
    )
    if batch:
        results = upload_files_parallel(batch)
        cursor = 0
        if pdf_job:
            if results[cursor]:
                daily.pdf_url = results[cursor]
            cursor += 1
        if has_ann:
            daily.photo_urls = [u for u in results[cursor:cursor + len(ann_jobs)] if u]
            cursor += len(ann_jobs)
        if has_seed:
            daily.seed_tag_photo_urls = [u for u in results[cursor:cursor + len(seed_jobs)] if u]
    else:
        # Worker explicitly cleared one of the photo lists (sent []) — preserve
        # that intent. The `is not None` check above means an empty list still
        # produces no jobs; we still need to wipe the column.
        if has_ann:
            daily.photo_urls = []
        if has_seed:
            daily.seed_tag_photo_urls = []

    # daily_data snapshot
    if payload.daily_data is not None:
        snapshot = {**payload.daily_data, "record_number": daily.record_number}
        daily.daily_data = _strip_photo_bytes_from_daily_data(snapshot)

    # Ticket re-link
    if payload.hydroseed_ticket_link is not None:
        link = payload.hydroseed_ticket_link
        if link.ticket_id is None and not link.create:
            # Explicit unlink
            old_ticket = daily.ticket
            daily.hydroseed_ticket_id = None
            _resync_ticket_rows_for_daily(db, daily, None)
            if old_ticket is not None:
                old_ticket.updated_at = datetime.utcnow()
        else:
            ticket = _find_or_create_ticket_for_daily(
                db=db,
                daily=daily,
                link_ticket_id=link.ticket_id,
                link_create=link.create,
                description_of_work=link.description_of_work,
                current_user=current_user,
            )
            if ticket is not None:
                old_ticket = daily.ticket
                daily.hydroseed_ticket_id = ticket.id
                _resync_ticket_rows_for_daily(db, daily, ticket)
                if old_ticket is not None and old_ticket.id != ticket.id:
                    old_ticket.updated_at = datetime.utcnow()
    elif payload.daily_data is not None and daily.ticket is not None:
        # Edit on a linked daily — re-sync rows so totals reflect the new loads.
        _resync_ticket_rows_for_daily(db, daily, daily.ticket)

    daily.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(daily)
    return HydroseedDailyRead.model_validate(daily)


# ── Soft delete / restore ───────────────────────────────────────────────────

@router.delete(
    "/dailies/{daily_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_roles(RoleEnum.admin, RoleEnum.office))],
)
def delete_daily(
    daily_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    daily = db.query(HydroseedDailyRecord).filter(
        HydroseedDailyRecord.id == daily_id,
        HydroseedDailyRecord.deleted_at.is_(None),
    ).first()
    if not daily:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Daily not found")
    now = datetime.utcnow()
    daily.deleted_at = now
    daily.deleted_by_user_id = current_user.id
    daily.updated_at = now
    # Cascade-clear its contributions on the linked ticket so totals don't keep
    # phantom rows.
    parent_ticket = daily.ticket
    db.query(HydroseedTicketRow).filter(
        HydroseedTicketRow.daily_record_id == daily.id
    ).delete(synchronize_session=False)
    if parent_ticket is not None:
        parent_ticket.updated_at = now
    db.commit()


@router.post(
    "/dailies/{daily_id}/restore",
    dependencies=[Depends(require_roles(RoleEnum.admin, RoleEnum.office))],
)
def restore_daily(
    daily_id: int,
    db: Session = Depends(get_db),
):
    daily = db.query(HydroseedDailyRecord).filter(
        HydroseedDailyRecord.id == daily_id,
        HydroseedDailyRecord.deleted_at.isnot(None),
    ).first()
    if not daily:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Daily not found")
    daily.deleted_at = None
    daily.updated_at = datetime.utcnow()
    # Re-aggregate rows back onto the ticket if it's still around.
    if daily.ticket is not None and daily.ticket.deleted_at is None:
        _resync_ticket_rows_for_daily(db, daily, daily.ticket)
    db.commit()
    return {"success": True}


@router.delete(
    "/dailies/{daily_id}/permanent",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_roles(RoleEnum.admin))],
)
def delete_daily_permanent(
    daily_id: int,
    db: Session = Depends(get_db),
):
    """Hard-delete a soft-deleted hydroseed daily. Admin only. Mirrors
    `DELETE /api/time-materials/{id}/permanent`."""
    daily = (
        db.query(HydroseedDailyRecord)
        .filter(HydroseedDailyRecord.id == daily_id)
        .first()
    )
    if not daily:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Daily not found")
    # Roll up rows first so the cascade-delete leaves no orphans.
    db.query(HydroseedTicketRow).filter(
        HydroseedTicketRow.daily_record_id == daily.id
    ).delete(synchronize_session=False)
    db.delete(daily)
    db.commit()


# ════════════════════════════════════════════════════════════════════════════
# TICKETS
# ════════════════════════════════════════════════════════════════════════════


@router.get("/tickets/open", response_model=list[HydroseedTicketRead])
def list_open_tickets(
    client: str | None = Query(default=None),
    area: str | None = Query(default=None),
    work_date: date | None = Query(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Open HT tickets, always scoped to the CURRENT user (used by the daily
    submit picker). Office/admin who want everyone's tickets use /tickets."""
    q = db.query(HydroseedTicket).options(
        joinedload(HydroseedTicket.rows),
    ).filter(
        HydroseedTicket.status == TMTicketStatus.open,
        HydroseedTicket.deleted_at.is_(None),
        or_(
            HydroseedTicket.created_by_user_id == current_user.id,
            and_(
                HydroseedTicket.created_by_user_id.is_(None),
                HydroseedTicket.created_by_name == current_user.name,
            ),
        ),
    )
    if client:
        q = q.filter(HydroseedTicket.client == client)
    if area:
        q = q.filter(HydroseedTicket.area == area)
    if work_date:
        q = q.filter(HydroseedTicket.work_date == work_date)
    tickets = q.order_by(HydroseedTicket.created_at.desc()).all()
    return [_strip_office_fields_for_worker(t, current_user) for t in tickets]


@router.get("/tickets", response_model=list[HydroseedTicketRead])
def list_tickets(
    status_filter: TMTicketStatus | None = Query(default=None, alias="status"),
    work_date: date | None = Query(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    q = _slim_tickets_query(db, current_user)
    if status_filter is not None:
        q = q.filter(HydroseedTicket.status == status_filter)
    if work_date:
        q = q.filter(HydroseedTicket.work_date == work_date)
    tickets = q.order_by(HydroseedTicket.created_at.desc()).limit(200).all()
    return [_strip_office_fields_for_worker(t, current_user) for t in tickets]


# Declared BEFORE /tickets/{id} so FastAPI doesn't route 'deleted' as an id.
@router.get("/tickets/deleted", response_model=list[HydroseedTicketRead])
def list_deleted_tickets(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_roles(RoleEnum.admin, RoleEnum.office)),
):
    """List soft-deleted hydroseed tickets (admin/office only)."""
    tickets = (
        db.query(HydroseedTicket)
        .options(
            joinedload(HydroseedTicket.rows),
            joinedload(HydroseedTicket.daily_records),
        )
        .filter(HydroseedTicket.deleted_at.isnot(None))
        .order_by(HydroseedTicket.deleted_at.desc())
        .limit(500)
        .all()
    )
    return [HydroseedTicketRead.model_validate(t) for t in tickets]


@router.get("/tickets/delta", response_model=HydroseedTicketsDeltaResponse)
def tickets_delta(
    since: datetime = Query(..., description="ISO timestamp from a previous server_time"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    server_time = datetime.utcnow()
    base = _slim_tickets_query(db, current_user, include_deleted=True).filter(
        HydroseedTicket.updated_at > since
    )
    rows = base.order_by(HydroseedTicket.updated_at.desc()).limit(500).all()
    items: list[HydroseedTicketDeltaRow] = []
    ids_removed: list[int] = []
    for t in rows:
        if t.deleted_at is not None:
            ids_removed.append(t.id)
        else:
            items.append(HydroseedTicketDeltaRow.model_validate(t))
    return HydroseedTicketsDeltaResponse(items=items, ids_removed=ids_removed, server_time=server_time)


@router.get("/tickets/{ticket_id}", response_model=HydroseedTicketRead)
def get_ticket(
    ticket_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    ticket = _visible_tickets_query(db, current_user).filter(
        HydroseedTicket.id == ticket_id
    ).first()
    if not ticket:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Ticket not found")
    return _strip_office_fields_for_worker(ticket, current_user)


@router.post("/tickets", response_model=HydroseedTicketRead, status_code=status.HTTP_201_CREATED)
def create_ticket(
    payload: HydroseedTicketCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    ticket_number = _allocate_ticket_number(db)
    user_name = getattr(current_user, "name", None) or (
        current_user.email.split("@")[0].title() if current_user.email else None
    )
    ticket = HydroseedTicket(
        ticket_number=ticket_number,
        work_date=payload.work_date,
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


@router.patch("/tickets/{ticket_id}", response_model=HydroseedTicketRead)
def update_ticket(
    ticket_id: int,
    payload: HydroseedTicketUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update an HT ticket. Office writes office_data + rates + signs. Workers
    can update description_of_work on their own open/submitted tickets.

    Unlike T&M, HT has NO worker-editable QTY fields on office_data (all qtys
    come from rolled-up daily data). So workers never write office_data.
    """
    ticket = db.query(HydroseedTicket).options(
        joinedload(HydroseedTicket.rows),
        joinedload(HydroseedTicket.daily_records),
    ).filter(
        HydroseedTicket.id == ticket_id
    ).first()
    if not ticket:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Ticket not found")

    is_office = current_user.role in (RoleEnum.admin, RoleEnum.office)
    is_owner = _worker_owns_ticket(ticket, current_user)
    if not (is_office or is_owner):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not allowed")

    # Frozen-when-approved guard (workers only).
    if not is_office and ticket.status == TMTicketStatus.approved:
        if any([
            payload.description_of_work is not None,
            payload.office_data is not None,
            payload.status is not None,
            payload.pdf_base64,
            payload.po_approval_number is not None,
            payload.approved_signature is not None,
            payload.approve,
        ]):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="This ticket has already been approved — ask office to unapprove it if edits are needed",
            )

    if payload.description_of_work is not None:
        ticket.description_of_work = payload.description_of_work

    if is_office:
        if payload.client is not None:
            ticket.client = payload.client
        if payload.area is not None:
            ticket.area = payload.area
        if payload.po_approval_number is not None:
            ticket.po_approval_number = payload.po_approval_number
        if payload.office_data is not None:
            ticket.office_data = payload.office_data
        if payload.status is not None:
            # Unapproving: wipe approval metadata.
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
            ticket.status = TMTicketStatus.approved
            ticket.approved_at = datetime.utcnow()
            ticket.approved_by_user_id = current_user.id
            ticket.approved_by_name = getattr(current_user, "name", None) or (
                current_user.email.split("@")[0].title() if current_user.email else None
            )
    else:
        # Worker write surface is small: just description_of_work + the
        # one-way open→submitted hand-off.
        if any([
            payload.po_approval_number is not None,
            payload.approved_signature is not None,
            payload.approve,
            payload.office_data is not None,
        ]):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Office-only fields")
        if payload.status is not None:
            if payload.status != TMTicketStatus.submitted or ticket.status != TMTicketStatus.open:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="Workers can only submit an open ticket for approval",
                )
            ticket.status = TMTicketStatus.submitted

    # PDF upload — skip while the ticket is still open (avoid Dropbox churn
    # while office is mid-edit). Same rule as T&M.
    if payload.pdf_base64 and ticket.status != TMTicketStatus.open:
        new_url = _upload_ticket_pdf(ticket, payload.pdf_base64)
        if new_url:
            ticket.pdf_url = new_url

    ticket.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(ticket)
    return _strip_office_fields_for_worker(ticket, current_user)


@router.delete(
    "/tickets/{ticket_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_roles(RoleEnum.admin, RoleEnum.office))],
)
def delete_ticket(
    ticket_id: int,
    db: Session = Depends(get_db),
):
    ticket = db.query(HydroseedTicket).filter(
        HydroseedTicket.id == ticket_id,
        HydroseedTicket.deleted_at.is_(None),
    ).first()
    if not ticket:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Ticket not found")
    now = datetime.utcnow()
    for daily in list(ticket.daily_records):
        daily.hydroseed_ticket_id = None
    ticket.deleted_at = now
    ticket.updated_at = now
    db.commit()


@router.post(
    "/tickets/{ticket_id}/restore",
    dependencies=[Depends(require_roles(RoleEnum.admin, RoleEnum.office))],
)
def restore_ticket(
    ticket_id: int,
    db: Session = Depends(get_db),
):
    ticket = db.query(HydroseedTicket).filter(
        HydroseedTicket.id == ticket_id,
        HydroseedTicket.deleted_at.isnot(None),
    ).first()
    if not ticket:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Ticket not found")
    ticket.deleted_at = None
    ticket.updated_at = datetime.utcnow()
    db.commit()
    return {"success": True}


@router.delete(
    "/tickets/{ticket_id}/permanent",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_roles(RoleEnum.admin))],
)
def delete_ticket_permanent(
    ticket_id: int,
    db: Session = Depends(get_db),
):
    ticket = db.query(HydroseedTicket).filter(HydroseedTicket.id == ticket_id).first()
    if not ticket:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Ticket not found")
    db.delete(ticket)
    db.commit()
