"""Quote Builder draft endpoints.

Drafts are per-user and stored server-side so they are accessible from any
device the operator uses. The full form state is stored as JSONB in `data`
and treated as an opaque blob by the backend — validation happens on submit,
not on save.

Route prefix: /api/quotes/drafts
Auth: admin or office (same as the rest of the Quotes router).

IMPORTANT: this router must be included in main.py BEFORE the main quotes
router so that /api/quotes/drafts doesn't get swallowed by the
/api/quotes/{quote_id} integer path param.
"""
from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict
from sqlalchemy.orm import Session

from app.auth import require_roles
from app.database import get_db
from app.models import QuoteDraft, RoleEnum, User

router = APIRouter(
    prefix="/api/quotes/drafts",
    tags=["quote-drafts"],
    dependencies=[Depends(require_roles(RoleEnum.admin, RoleEnum.office))],
)


# ── Pydantic schemas ──────────────────────────────────────────────────────

class QuoteDraftRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    data: dict
    created_at: datetime
    updated_at: datetime


class QuoteDraftCreate(BaseModel):
    name: str = "Untitled"
    data: dict


class QuoteDraftUpdate(BaseModel):
    name: str | None = None
    data: dict | None = None


# ── Endpoints ─────────────────────────────────────────────────────────────

@router.get("", response_model=list[QuoteDraftRead])
def list_drafts(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_roles(RoleEnum.admin, RoleEnum.office)),
):
    """Return all drafts belonging to the current user, newest first."""
    return (
        db.query(QuoteDraft)
        .filter(QuoteDraft.user_id == current_user.id)
        .order_by(QuoteDraft.updated_at.desc())
        .all()
    )


@router.post("", response_model=QuoteDraftRead, status_code=status.HTTP_201_CREATED)
def create_draft(
    payload: QuoteDraftCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_roles(RoleEnum.admin, RoleEnum.office)),
):
    """Save a new draft for the current user."""
    draft = QuoteDraft(
        user_id=current_user.id,
        name=payload.name or "Untitled",
        data=payload.data,
    )
    db.add(draft)
    db.commit()
    db.refresh(draft)
    return draft


@router.patch("/{draft_id}", response_model=QuoteDraftRead)
def update_draft(
    draft_id: int,
    payload: QuoteDraftUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_roles(RoleEnum.admin, RoleEnum.office)),
):
    """Update an existing draft. Only the owning user may update it."""
    draft = (
        db.query(QuoteDraft)
        .filter(QuoteDraft.id == draft_id, QuoteDraft.user_id == current_user.id)
        .first()
    )
    if not draft:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Draft not found")
    if payload.name is not None:
        draft.name = payload.name
    if payload.data is not None:
        draft.data = payload.data
    draft.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(draft)
    return draft


@router.delete("/{draft_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_draft(
    draft_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_roles(RoleEnum.admin, RoleEnum.office)),
):
    """Permanently delete a draft. Only the owning user may delete it."""
    draft = (
        db.query(QuoteDraft)
        .filter(QuoteDraft.id == draft_id, QuoteDraft.user_id == current_user.id)
        .first()
    )
    if not draft:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Draft not found")
    db.delete(draft)
    db.commit()
