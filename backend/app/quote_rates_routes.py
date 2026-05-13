"""Admin/office endpoints for the Quote Builder rate catalog.

Two tables under management here:
  • `quote_rate_categories` — Hydroseeding / Herbicide Application / Drone Map / Drone Seed.
  • `quote_rate_items`      — Catalog of priced line items inside each category.

Edits go through the Settings tab INSIDE the Quote Builder overlay — these
endpoints are NOT mixed into the existing Lookup Tables panel. The route
prefix /api/quote-rates is deliberately distinct so they can be reasoned
about independently when monthly rate updates land.
"""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session, joinedload

from app.auth import require_roles
from app.database import get_db
from app.models import QuoteRateCategory, QuoteRateItem, RoleEnum, User

router = APIRouter(
    prefix="/api/quote-rates",
    tags=["quote-rates"],
    # Every route in here is admin/office only. Workers never get a Quote
    # Builder button so this is purely belt-and-suspenders to prevent any
    # accidental worker-token access from leaking pricing data.
    dependencies=[Depends(require_roles(RoleEnum.admin, RoleEnum.office))],
)


# ── Pydantic schemas ──────────────────────────────────────────────────────

class QuoteRateItemRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    category_id: int
    name: str
    unit: str
    rate: float
    notes: str | None = None
    default_markup_pct: float | None = None
    default_markup_label: str | None = None
    sort_order: int
    is_active: bool


class QuoteRateCategoryRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    notes: str | None = None
    sort_order: int
    is_active: bool
    items: list[QuoteRateItemRead] = Field(default_factory=list)


class QuoteRateCategoryCreate(BaseModel):
    name: str
    notes: str | None = None
    sort_order: int = 0


class QuoteRateCategoryUpdate(BaseModel):
    name: str | None = None
    notes: str | None = None
    sort_order: int | None = None
    is_active: bool | None = None


class QuoteRateItemCreate(BaseModel):
    category_id: int
    name: str
    unit: str = ""
    rate: float = 0
    notes: str | None = None
    default_markup_pct: float | None = None
    default_markup_label: str | None = None
    sort_order: int = 0


class QuoteRateItemUpdate(BaseModel):
    name: str | None = None
    unit: str | None = None
    rate: float | None = None
    notes: str | None = None
    default_markup_pct: float | None = None
    default_markup_label: str | None = None
    sort_order: int | None = None
    is_active: bool | None = None


# ── Read ───────────────────────────────────────────────────────────────────

@router.get("", response_model=list[QuoteRateCategoryRead])
def list_categories(db: Session = Depends(get_db)):
    """Return every active category with its active items, in display order.

    Single call — the Quote Builder overlay reads the entire catalog on
    open (small payload, ~30 rows) so all category/item dropdowns can
    render instantly without further round-trips.
    """
    cats = (
        db.query(QuoteRateCategory)
        .options(joinedload(QuoteRateCategory.items))
        .filter(QuoteRateCategory.is_active.is_(True))
        .order_by(QuoteRateCategory.sort_order, QuoteRateCategory.name)
        .all()
    )
    # Filter items to only-active within each category. We don't push this
    # into the SQL filter so soft-deleted items still cascade through the
    # joined load without surprising the serializer.
    for c in cats:
        c.items = [i for i in c.items if i.is_active]
        c.items.sort(key=lambda i: (i.sort_order, i.name))
    return cats


# ── Category mutations ─────────────────────────────────────────────────────

@router.post("/categories", response_model=QuoteRateCategoryRead, status_code=status.HTTP_201_CREATED)
def create_category(payload: QuoteRateCategoryCreate, db: Session = Depends(get_db)):
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name is required")
    # Allow recovering a soft-deleted category with the same name rather
    # than 409'ing — the admin clearly wants this name back. Same gentle
    # ergonomics LookupManager has for herbicides / applicators.
    existing = db.query(QuoteRateCategory).filter(QuoteRateCategory.name.ilike(name)).first()
    if existing:
        if existing.is_active:
            raise HTTPException(status_code=409, detail=f"Category '{name}' already exists")
        existing.is_active = True
        existing.notes = payload.notes
        existing.sort_order = payload.sort_order
        existing.updated_at = datetime.utcnow()
        db.commit()
        db.refresh(existing)
        return existing
    cat = QuoteRateCategory(
        name=name,
        notes=payload.notes,
        sort_order=payload.sort_order,
    )
    db.add(cat)
    db.commit()
    db.refresh(cat)
    return cat


@router.patch("/categories/{category_id}", response_model=QuoteRateCategoryRead)
def update_category(category_id: int, payload: QuoteRateCategoryUpdate, db: Session = Depends(get_db)):
    cat = db.query(QuoteRateCategory).filter(QuoteRateCategory.id == category_id).first()
    if not cat:
        raise HTTPException(status_code=404, detail="Category not found")
    data = payload.model_dump(exclude_unset=True)
    if "name" in data:
        new_name = (data["name"] or "").strip()
        if not new_name:
            raise HTTPException(status_code=400, detail="Name cannot be empty")
        clash = (
            db.query(QuoteRateCategory)
            .filter(QuoteRateCategory.name.ilike(new_name), QuoteRateCategory.id != cat.id)
            .first()
        )
        if clash:
            raise HTTPException(status_code=409, detail=f"Another category named '{new_name}' already exists")
        cat.name = new_name
    if "notes" in data:
        cat.notes = data["notes"]
    if "sort_order" in data and data["sort_order"] is not None:
        cat.sort_order = data["sort_order"]
    if "is_active" in data and data["is_active"] is not None:
        cat.is_active = data["is_active"]
    cat.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(cat)
    return cat


@router.delete("/categories/{category_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_category(category_id: int, db: Session = Depends(get_db)):
    """Soft-delete: flip is_active to false. Items belonging to it stay
    intact so a later restore brings the catalog back exactly as it was.
    Recently-submitted quotes are unaffected because they store a full
    snapshot of their line items in `quotes.line_items_json`.
    """
    cat = db.query(QuoteRateCategory).filter(QuoteRateCategory.id == category_id).first()
    if not cat:
        raise HTTPException(status_code=404, detail="Category not found")
    cat.is_active = False
    cat.updated_at = datetime.utcnow()
    db.commit()


# ── Item mutations ─────────────────────────────────────────────────────────

@router.post("/items", response_model=QuoteRateItemRead, status_code=status.HTTP_201_CREATED)
def create_item(payload: QuoteRateItemCreate, db: Session = Depends(get_db)):
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name is required")
    cat = db.query(QuoteRateCategory).filter(QuoteRateCategory.id == payload.category_id).first()
    if not cat:
        raise HTTPException(status_code=404, detail="Category not found")
    # Same revive-soft-deleted-duplicate pattern as categories.
    existing = (
        db.query(QuoteRateItem)
        .filter(QuoteRateItem.category_id == payload.category_id, QuoteRateItem.name.ilike(name))
        .first()
    )
    if existing:
        if existing.is_active:
            raise HTTPException(status_code=409, detail=f"Item '{name}' already exists in this category")
        existing.is_active = True
        existing.unit = payload.unit or ""
        existing.rate = payload.rate
        existing.notes = payload.notes
        existing.default_markup_pct = payload.default_markup_pct
        existing.default_markup_label = payload.default_markup_label
        existing.sort_order = payload.sort_order
        existing.updated_at = datetime.utcnow()
        db.commit()
        db.refresh(existing)
        return existing
    item = QuoteRateItem(
        category_id=payload.category_id,
        name=name,
        unit=payload.unit or "",
        rate=payload.rate,
        notes=payload.notes,
        default_markup_pct=payload.default_markup_pct,
        default_markup_label=payload.default_markup_label,
        sort_order=payload.sort_order,
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


@router.patch("/items/{item_id}", response_model=QuoteRateItemRead)
def update_item(item_id: int, payload: QuoteRateItemUpdate, db: Session = Depends(get_db)):
    item = db.query(QuoteRateItem).filter(QuoteRateItem.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")
    data = payload.model_dump(exclude_unset=True)
    if "name" in data:
        new_name = (data["name"] or "").strip()
        if not new_name:
            raise HTTPException(status_code=400, detail="Name cannot be empty")
        clash = (
            db.query(QuoteRateItem)
            .filter(
                QuoteRateItem.category_id == item.category_id,
                QuoteRateItem.name.ilike(new_name),
                QuoteRateItem.id != item.id,
            )
            .first()
        )
        if clash:
            raise HTTPException(status_code=409, detail=f"Another item named '{new_name}' already exists in this category")
        item.name = new_name
    for field in ("unit", "rate", "notes", "default_markup_pct", "default_markup_label", "sort_order", "is_active"):
        if field in data:
            setattr(item, field, data[field])
    item.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(item)
    return item


@router.delete("/items/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_item(item_id: int, db: Session = Depends(get_db)):
    """Soft-delete: flip is_active to false. Same rationale as categories —
    historical quotes already snapshotted the row's values, so removing
    from the catalog never rewrites the past.
    """
    item = db.query(QuoteRateItem).filter(QuoteRateItem.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")
    item.is_active = False
    item.updated_at = datetime.utcnow()
    db.commit()
