"""Quote Builder submit / list / restore endpoints.

Numbering is server-side via the dedicated `quote_seq` Postgres sequence,
formatted as `Q{seq:06d}` — same pattern as `HL######` (lease sheets) and
`TM######` (T&M tickets). The number is allocated atomically inside the
submit transaction so two concurrent submits can never collide.

Dropbox layout: `/{YYYY} Quotes/{Client}/{Quote#}_{YYYY-MM-DD}.pdf`. The year
comes from the user-entered `quote_date` (matches `build_pdf_path()` for
lease sheets, which keys folder year off the spray date).

Soft-delete via `deleted_at` so AdminPanel → Recent Deletes can surface
restorable rows alongside lease sheets and T&M tickets.

IMPORTANT route ordering: `/recent` and `/deleted` must be registered
before `/{quote_id}` or FastAPI will try to parse those words as the
path-int param and 422. Order below is preserved for that reason.
"""
from __future__ import annotations

import base64
import re
from datetime import date as date_type, datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth import require_roles
from app.database import get_db
from app.dropbox_integration import _safe_name, delete_dropbox_path, upload_pdf_to_dropbox
from app.log_util import get_logger
from app.models import Quote, RoleEnum, User

logger = get_logger(__name__)

router = APIRouter(
    prefix="/api/quotes",
    tags=["quotes"],
    dependencies=[Depends(require_roles(RoleEnum.admin, RoleEnum.office))],
)


# ── Pydantic schemas ──────────────────────────────────────────────────────

class QuoteRead(BaseModel):
    """Slim view for the Recent Quotes list. Drops `line_items_json` to keep
    the list response tiny — the detail endpoint loads the full array.
    """
    model_config = ConfigDict(from_attributes=True)

    id: int
    quote_number: str
    client: str
    area: str | None = None
    location: str | None = None
    project_description: str | None = None
    quote_date: date_type
    mix_categories: bool
    tax_enabled: bool
    tax_label: str | None = None
    tax_rate: float | None = None
    subtotal: float
    tax_amount: float
    grand_total: float
    notes: str | None = None
    pdf_url: str | None = None
    created_by_user_id: int | None = None
    created_by_email: str | None = None
    created_by_name: str | None = None
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None = None


class QuoteDetail(QuoteRead):
    """Recent-list slim view + the full line_items_json array. Returned by
    GET /api/quotes/{id} and used by the *Duplicate as new* flow.
    """
    line_items_json: list = Field(default_factory=list)


class QuoteLineItemPayload(BaseModel):
    """One row in the quote, mirroring the frontend representation. Kept
    intentionally permissive so the catalog can evolve and old quotes still
    deserialize.

    `kind` is one of: `"catalog"`, `"custom"`, `"note"`. For `"note"` rows
    only `description` is meaningful; price columns are ignored.
    """
    kind: str = "catalog"
    category_id: int | None = None
    category_name: str | None = None
    item_id: int | None = None
    description: str = ""
    unit: str = ""
    qty: float | None = None
    rate: float | None = None
    markup_enabled: bool = False
    markup_pct: float | None = None
    markup_label: str | None = None
    subtotal: float = 0
    section_uid: str | None = None
    section_location: str | None = None


class QuoteCreate(BaseModel):
    client: str
    area: str | None = None
    location: str | None = None
    project_description: str | None = None
    quote_date: date_type
    mix_categories: bool = False
    tax_enabled: bool = False
    tax_label: str | None = None
    tax_rate: float | None = None
    line_items: list[QuoteLineItemPayload] = Field(default_factory=list)
    notes: str | None = None
    pdf_base64: str | None = None
    # Optional `Q######` from /peek-number — the frontend renders the
    # preview/print PDF with this number visible, then submits with it set
    # so the persisted quote_number matches what the user saw on screen.
    # If two operators race, the loser's submit silently falls back to a
    # fresh nextval allocation (their PDF will have a slightly stale
    # number, which is acceptable for a 1-2 admin team).
    expected_quote_number: str | None = None


class QuoteUpdate(BaseModel):
    """Edit-and-resubmit payload. Same shape as QuoteCreate minus the
    quote-number allocation knobs — the existing `quote_number` is
    preserved across the update so the Dropbox path stays stable when
    client/date are unchanged. If client or quote_date *do* change, the
    PDF is uploaded to the new path and the old file is best-effort
    deleted so we don't leave orphans behind.
    """
    client: str
    area: str | None = None
    location: str | None = None
    project_description: str | None = None
    quote_date: date_type
    mix_categories: bool = False
    tax_enabled: bool = False
    tax_label: str | None = None
    tax_rate: float | None = None
    line_items: list[QuoteLineItemPayload] = Field(default_factory=list)
    notes: str | None = None
    pdf_base64: str | None = None


# ── Helpers ───────────────────────────────────────────────────────────────

def _allocate_quote_number(db: Session) -> str:
    """`Q######` from the shared `quote_seq`. Atomic via Postgres nextval."""
    result = db.execute(text("SELECT nextval('quote_seq')"))
    seq_value = result.scalar()
    return f"Q{seq_value:06d}"


def _peek_next_quote_number(db: Session) -> str:
    """Return the next `Q######` that nextval('quote_seq') would yield,
    WITHOUT consuming the sequence. Used by the New Quote form so the
    preview PDF can show the actual upcoming number instead of a
    placeholder, while leaving the number available for the next quote
    if the user closes without submitting.

    `last_value` + (1 if `is_called` else 0) is the standard way to peek
    a Postgres sequence's next value. `is_called=false` means nextval has
    never been invoked since the last setval(...,false) — in that case
    the next nextval returns last_value itself.
    """
    row = db.execute(text("SELECT last_value, is_called FROM quote_seq")).fetchone()
    if row is None:
        next_val = 1
    else:
        last_value, is_called = row
        next_val = last_value + 1 if is_called else last_value
    return f"Q{next_val:06d}"


_QUOTE_NUMBER_RE = re.compile(r"^Q(\d{6})$")


def _allocate_with_expected(db: Session, expected: str | None) -> str:
    """Allocate a `Q######`. If `expected` is supplied (from peek) and is
    still ahead of the current sequence position, atomically advance the
    sequence to that exact value. Otherwise fall through to plain nextval
    (which is what races and stale peeks land on).

    Idempotent re-allocation on UNIQUE collision is handled by the caller.
    """
    if expected:
        m = _QUOTE_NUMBER_RE.match(expected.strip())
        if m:
            try:
                expected_seq = int(m.group(1))
                # Atomic: max(current, expected) becomes the new last_value
                # with is_called=true, so the *next* nextval would return
                # last_value+1. Returns the assigned value.
                row = db.execute(
                    text(
                        "SELECT setval('quote_seq', "
                        "GREATEST((SELECT last_value FROM quote_seq), :v), true)"
                    ),
                    {"v": expected_seq},
                ).scalar()
                # Use whichever number setval landed on. If two operators
                # peeked the same number, the second setval is a no-op
                # (current already at expected), they get the same number,
                # and the UNIQUE constraint on quote_number rejects the
                # second insert — see submit_quote()'s retry block.
                return f"Q{int(row):06d}"
            except Exception as e:
                logger.warning(
                    "expected_quote_number=%r unusable (%s); falling back to nextval",
                    expected, type(e).__name__,
                )
    return _allocate_quote_number(db)


def _build_quote_pdf_path(quote_date: date_type, client: str, quote_number: str) -> str:
    """Dropbox path: `/{YYYY} Quotes/{Client}/{Quote#}_{YYYY-MM-DD}.pdf`.

    Year comes from `quote_date` to match how lease-sheet PDFs are filed
    under the spray date's year (`build_pdf_path()` in dropbox_integration).
    """
    year = quote_date.strftime("%Y")
    date_str = quote_date.strftime("%Y-%m-%d")
    return f"/{year} Quotes/{_safe_name(client)}/{_safe_name(quote_number)}_{date_str}.pdf"


def _compute_totals(line_items: list[QuoteLineItemPayload], tax_enabled: bool, tax_rate: Optional[float]) -> tuple[float, float, float]:
    """Server-side recompute of subtotal / tax / grand total. We trust the
    client-supplied subtotals on each line for ergonomics (markups,
    rounding, custom-line quirks), but recompute the aggregate so a buggy
    or tampered client can't ship a $1 quote for a $10,000 job.

    Returns (subtotal, tax_amount, grand_total).
    """
    subtotal = 0.0
    for line in line_items:
        if (line.kind or "catalog") == "note":
            continue
        try:
            subtotal += float(line.subtotal or 0)
        except (TypeError, ValueError):
            continue
    tax_amount = 0.0
    if tax_enabled and tax_rate is not None:
        try:
            tax_amount = round(subtotal * (float(tax_rate) / 100.0), 2)
        except (TypeError, ValueError):
            tax_amount = 0.0
    grand_total = round(subtotal + tax_amount, 2)
    return round(subtotal, 2), tax_amount, grand_total


# ── Submit ─────────────────────────────────────────────────────────────────

@router.post("", response_model=QuoteDetail, status_code=status.HTTP_201_CREATED)
def submit_quote(
    payload: QuoteCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_roles(RoleEnum.admin, RoleEnum.office)),
):
    """Allocate `Q######`, upload PDF to Dropbox, persist the quote row.

    The PDF is generated client-side (jsPDF) and posted as base64 — same
    pattern as lease sheets / T&M tickets. If `pdf_base64` is omitted or
    the upload fails, the quote still persists but `pdf_url` stays NULL —
    the operator can re-print and re-upload later if needed.
    """
    client = (payload.client or "").strip()
    if not client:
        raise HTTPException(status_code=400, detail="Client is required")
    if not payload.line_items:
        raise HTTPException(status_code=400, detail="Quote must include at least one line item")

    # Attempt to honor the peeked number first. On UNIQUE collision (very
    # rare race: two ops submitted with the same expected number), we
    # retry once with a plain nextval so the user isn't left with a 500.
    quote_number = _allocate_with_expected(db, payload.expected_quote_number)
    subtotal, tax_amount, grand_total = _compute_totals(
        payload.line_items, payload.tax_enabled, payload.tax_rate
    )

    pdf_url: Optional[str] = None
    if payload.pdf_base64:
        try:
            pdf_bytes = base64.b64decode(payload.pdf_base64)
            pdf_path = _build_quote_pdf_path(payload.quote_date, client, quote_number)
            pdf_url = upload_pdf_to_dropbox(pdf_bytes, pdf_path)
        except Exception as e:
            # Don't fail the submission — the quote row + sequence value
            # are already committed-to-be. Log so we know to investigate
            # if the office reports a missing Dropbox upload.
            logger.warning("Quote %s PDF upload failed: %s", quote_number, type(e).__name__)
            pdf_url = None

    def _build_quote_row(qn: str, url: Optional[str]) -> Quote:
        return Quote(
            quote_number=qn,
            client=client,
            area=(payload.area or '').strip() or None,
            location=(payload.location or '').strip() or None,
            project_description=payload.project_description,
            quote_date=payload.quote_date,
            mix_categories=payload.mix_categories,
            tax_enabled=payload.tax_enabled,
            tax_label=payload.tax_label,
            tax_rate=payload.tax_rate,
            subtotal=subtotal,
            tax_amount=tax_amount,
            grand_total=grand_total,
            line_items_json=[li.model_dump() for li in payload.line_items],
            notes=payload.notes,
            pdf_url=url,
            created_by_user_id=current_user.id if current_user else None,
            created_by_email=current_user.email if current_user else None,
            created_by_name=current_user.name if current_user else None,
        )

    quote = _build_quote_row(quote_number, pdf_url)
    db.add(quote)
    try:
        db.commit()
    except IntegrityError:
        # Race recovery: someone else committed the same quote_number first.
        # Roll back, allocate a fresh number via plain nextval, re-upload
        # the PDF under the new path, retry the insert.
        db.rollback()
        logger.warning(
            "Quote %s collided on UNIQUE; retrying with fresh nextval", quote_number,
        )
        quote_number = _allocate_quote_number(db)
        if payload.pdf_base64:
            try:
                pdf_bytes = base64.b64decode(payload.pdf_base64)
                pdf_path = _build_quote_pdf_path(payload.quote_date, client, quote_number)
                pdf_url = upload_pdf_to_dropbox(pdf_bytes, pdf_path)
            except Exception as e:
                logger.warning(
                    "Quote %s retry PDF upload failed: %s",
                    quote_number, type(e).__name__,
                )
                pdf_url = None
        quote = _build_quote_row(quote_number, pdf_url)
        db.add(quote)
        db.commit()
    db.refresh(quote)
    return quote


# ── List endpoints ─────────────────────────────────────────────────────────
# IMPORTANT: keep `/recent`, `/deleted`, and `/peek-number` BEFORE
# `/{quote_id}` — FastAPI matches in registration order and would
# otherwise try to parse those words as the int path param and 422.

@router.get("/peek-number")
def peek_quote_number(db: Session = Depends(get_db)):
    """Return the next `Q######` that nextval would yield, WITHOUT
    consuming the sequence. The frontend calls this when the user opens
    Preview / clicks Submit so the rendered PDF can show the actual
    upcoming number. If the user closes without submitting, no number is
    burned and the next quote starts at the same value.
    """
    return {"quote_number": _peek_next_quote_number(db)}


@router.get("/recent", response_model=list[QuoteRead])
def list_recent(
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    client: str | None = Query(default=None),
    from_date: date_type | None = Query(default=None, alias="from"),
    to_date: date_type | None = Query(default=None, alias="to"),
    db: Session = Depends(get_db),
):
    """Most recent submitted quotes, most recent first. Soft-deleted rows
    are excluded (they appear in `/deleted` instead).
    """
    q = db.query(Quote).filter(Quote.deleted_at.is_(None))
    if client:
        q = q.filter(Quote.client.ilike(f"%{client.strip()}%"))
    if from_date:
        q = q.filter(Quote.quote_date >= from_date)
    if to_date:
        q = q.filter(Quote.quote_date <= to_date)
    rows = q.order_by(Quote.created_at.desc()).offset(offset).limit(limit).all()
    return rows


@router.get("/deleted", response_model=list[QuoteRead])
def list_deleted(db: Session = Depends(get_db)):
    """Soft-deleted quotes for the AdminPanel → Recent Deletes panel."""
    rows = (
        db.query(Quote)
        .filter(Quote.deleted_at.isnot(None))
        .order_by(Quote.deleted_at.desc())
        .all()
    )
    return rows


@router.get("/{quote_id}", response_model=QuoteDetail)
def get_quote(quote_id: int, db: Session = Depends(get_db)):
    """Single quote with its full line_items_json. Used by the inline PDF
    preview tab and the *Duplicate as new* flow.
    """
    quote = db.query(Quote).filter(Quote.id == quote_id).first()
    if not quote:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Quote not found")
    return quote


# ── Update (edit & resubmit) ───────────────────────────────────────────────

@router.put("/{quote_id}", response_model=QuoteDetail)
def update_quote(
    quote_id: int,
    payload: QuoteUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_roles(RoleEnum.admin, RoleEnum.office)),
):
    """Edit a previously-submitted quote and overwrite its Dropbox PDF.

    The existing `quote_number` is preserved so the quote keeps its
    identity (and the same row on the Recent Quotes list). The PDF is
    re-rendered client-side with the same number stamped on it and
    uploaded to the canonical path for the (possibly new) client + date.

    If the client name or quote_date changed, the canonical path moves —
    we upload to the new path first, then best-effort delete the old
    file so we don't leave orphans behind. The `pdf_url` shared link
    is updated to the new path either way.

    Soft-deleted quotes can't be edited; restore first if needed.
    """
    quote = (
        db.query(Quote)
        .filter(Quote.id == quote_id, Quote.deleted_at.is_(None))
        .first()
    )
    if not quote:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Quote not found")

    client = (payload.client or "").strip()
    if not client:
        raise HTTPException(status_code=400, detail="Client is required")
    if not payload.line_items:
        raise HTTPException(status_code=400, detail="Quote must include at least one line item")

    subtotal, tax_amount, grand_total = _compute_totals(
        payload.line_items, payload.tax_enabled, payload.tax_rate
    )

    old_path = _build_quote_pdf_path(quote.quote_date, quote.client, quote.quote_number)
    new_path = _build_quote_pdf_path(payload.quote_date, client, quote.quote_number)

    new_pdf_url: Optional[str] = quote.pdf_url
    if payload.pdf_base64:
        try:
            pdf_bytes = base64.b64decode(payload.pdf_base64)
            new_pdf_url = upload_pdf_to_dropbox(pdf_bytes, new_path) or new_pdf_url
            # If the canonical path changed (client/date edited), the
            # previous file is now orphaned — best-effort clean up.
            if old_path != new_path:
                delete_dropbox_path(old_path)
        except Exception as e:
            logger.warning(
                "Quote %s update PDF upload failed: %s",
                quote.quote_number, type(e).__name__,
            )

    quote.client = client
    quote.area = (payload.area or "").strip() or None
    quote.location = (payload.location or '').strip() or None
    quote.project_description = payload.project_description
    quote.quote_date = payload.quote_date
    quote.mix_categories = payload.mix_categories
    quote.tax_enabled = payload.tax_enabled
    quote.tax_label = payload.tax_label
    quote.tax_rate = payload.tax_rate
    quote.subtotal = subtotal
    quote.tax_amount = tax_amount
    quote.grand_total = grand_total
    quote.line_items_json = [li.model_dump() for li in payload.line_items]
    quote.notes = payload.notes
    quote.pdf_url = new_pdf_url
    quote.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(quote)
    return quote


# ── Soft delete / restore / permanent ──────────────────────────────────────

@router.delete("/{quote_id}", status_code=status.HTTP_204_NO_CONTENT)
def soft_delete_quote(
    quote_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_roles(RoleEnum.admin, RoleEnum.office)),
):
    quote = (
        db.query(Quote)
        .filter(Quote.id == quote_id, Quote.deleted_at.is_(None))
        .first()
    )
    if not quote:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Quote not found")
    now = datetime.utcnow()
    quote.deleted_at = now
    quote.deleted_by_user_id = current_user.id if current_user else None
    quote.updated_at = now
    db.commit()


@router.post("/{quote_id}/restore")
def restore_quote(quote_id: int, db: Session = Depends(get_db)):
    quote = (
        db.query(Quote)
        .filter(Quote.id == quote_id, Quote.deleted_at.isnot(None))
        .first()
    )
    if not quote:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Quote not found")
    quote.deleted_at = None
    quote.deleted_by_user_id = None
    quote.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(quote)
    return {"success": True}


@router.delete(
    "/{quote_id}/permanent",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_roles(RoleEnum.admin))],
)
def hard_delete_quote(quote_id: int, db: Session = Depends(get_db)):
    """Permanent hard-delete. Admin only. The Dropbox PDF is left in place
    so it remains accessible via the shared link history — matches the
    behavior of lease-sheet / T&M permanent deletes.
    """
    quote = db.query(Quote).filter(Quote.id == quote_id).first()
    if not quote:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Quote not found")
    db.delete(quote)
    db.commit()
