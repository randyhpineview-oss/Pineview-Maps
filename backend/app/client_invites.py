"""Client self-signup via a single-use, admin-generated invite link (Flow B).

Flow:
  1. Admin (or field lead) picks one or more client companies (same list as
     the map's client filter) and, optionally, areas per company, then
     calls POST /api/admin/client-invites. Backend returns a URL of the
     form ``{frontend_url}/?client_invite=<token>``.
  2. Admin copies that URL and sends it themselves — by text, email,
     whatever — to the client contact. There is no in-app "send" button;
     the link itself is the invite.
  3. The client opens the link. The frontend calls
     GET /api/auth/client-invite/{token} to show them which company(ies)
     they're signing up for, then collects name/email/password and posts
     to POST /api/auth/client-signup.
  4. Backend validates the (unexpired, unused) token, creates the Supabase
     user with role="client" + the invite's client_access in
     `app_metadata` (never user_metadata — see app/auth.py), marks the
     invite used, and emails a confirmation link exactly like the
     existing worker QR-signup flow in app/signup.py.

This is Flow B, distinct from app/user_management.py::invite_client
(Flow A — admin enters the client's email directly and the backend emails
a personal setup link). Both produce the same end state: a
role="client" Supabase user scoped to one or more companies (+ optional
per-company areas).
"""

from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy.orm import Session
from supabase import create_client

from app.auth import MANAGES_PINS, get_current_user, require_roles
from app.client_scope import (
    build_scope_app_metadata,
    display_client_names,
    legacy_fields_from_access,
    parse_scope_payload,
    resolve_client_access,
)
from app.config import get_settings
from app.database import get_db
from app.email_service import send_signup_confirmation
from app.log_util import get_logger, mask_email
from app.models import ClientInvite, RoleEnum, User
from app.rate_limit import limiter

router = APIRouter(tags=["client-invites"])

settings = get_settings()
logger = get_logger(__name__)


def _get_supabase_admin():
    if not settings.supabase_url or not settings.supabase_service_role_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Supabase admin configuration not available",
        )
    return create_client(settings.supabase_url, settings.supabase_service_role_key)


# ── Schemas ──────────────────────────────────────────────────────────


class ClientAccessEntryIn(BaseModel):
    client: str
    areas: Optional[list[str]] = None


class CreateClientInviteRequest(BaseModel):
    client_access: Optional[list[ClientAccessEntryIn]] = None
    # Legacy single-company fields (still accepted).
    client_name: Optional[str] = None
    client_areas: Optional[list[str]] = None


class ClientInviteUrlResponse(BaseModel):
    url: str
    client_name: str
    client_areas: Optional[list[str]] = None
    client_access: Optional[list[dict]] = None
    expires_at: str


class ClientInviteInfoResponse(BaseModel):
    client_name: str
    client_areas: Optional[list[str]] = None
    client_access: Optional[list[dict]] = None


class ClientSignupRequest(BaseModel):
    token: str = Field(..., min_length=1, max_length=128)
    name: str = Field(..., min_length=1, max_length=120)
    email: EmailStr
    password: str = Field(..., min_length=6, max_length=128)


class ClientSignupResponse(BaseModel):
    message: str


def _invite_access(invite: ClientInvite) -> list[dict]:
    return resolve_client_access(
        client_access=getattr(invite, "client_access", None),
        client_name=invite.client_name,
        client_areas=invite.client_areas,
    )


# ── Admin: create + list invites ──────────────────────────────────────


@router.post(
    "/api/admin/client-invites",
    response_model=ClientInviteUrlResponse,
    dependencies=[Depends(require_roles(*MANAGES_PINS))],
)
def create_client_invite(
    payload: CreateClientInviteRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ClientInviteUrlResponse:
    if db is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Client invites are not available — backend has no database session.",
        )
    try:
        access = parse_scope_payload(
            client_access=[e.model_dump() for e in payload.client_access] if payload.client_access else None,
            client_name=payload.client_name,
            client_areas=payload.client_areas,
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))

    mirror_name, mirror_areas = legacy_fields_from_access(access)
    invite = ClientInvite(
        client_name=mirror_name or access[0]["client"],
        client_areas=mirror_areas,
        client_access=access,
        created_by_user_id=getattr(current_user, "id", None),
    )
    db.add(invite)
    db.commit()
    db.refresh(invite)

    url = f"{settings.frontend_url.rstrip('/')}/?client_invite={invite.token}"
    return ClientInviteUrlResponse(
        url=url,
        client_name=invite.client_name,
        client_areas=mirror_areas,
        client_access=access,
        expires_at=invite.expires_at.isoformat(),
    )


# ── Public: validate + consume ────────────────────────────────────────


@router.get("/api/auth/client-invite/{token}", response_model=ClientInviteInfoResponse)
@limiter.limit("30/hour")
def get_client_invite(
    request: Request,
    token: str,
    db: Session = Depends(get_db),
) -> ClientInviteInfoResponse:
    """Public lookup so the signup page can show "You're signing up for
    <Client(s)>" before the visitor enters anything. Never reveals whether a
    *different* token exists — only whether *this* token is currently
    valid.
    """
    if db is None:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Not available")
    invite = db.query(ClientInvite).filter(ClientInvite.token == token).first()
    if not invite or invite.is_used or invite.is_expired:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="This invite link is invalid or has expired. Ask your Pineview contact for a new one.",
        )
    access = _invite_access(invite)
    name, areas = legacy_fields_from_access(access)
    return ClientInviteInfoResponse(
        client_name=name or invite.client_name,
        client_areas=areas,
        client_access=access or None,
    )


@router.post(
    "/api/auth/client-signup",
    response_model=ClientSignupResponse,
    status_code=status.HTTP_200_OK,
)
@limiter.limit("5/hour")
async def client_signup(request: Request, payload: ClientSignupRequest, db: Session = Depends(get_db)) -> ClientSignupResponse:
    """Consume a single-use client invite link and create the account.

    Mirrors app/signup.py::worker_signup's shape (create user with
    email_confirm=False, mint a confirmation link, email it), but forces
    role="client" + the invite's client_access into `app_metadata` instead
    of `user_metadata`.
    """
    if db is None:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Not available")

    invite = db.query(ClientInvite).filter(ClientInvite.token == payload.token).first()
    if not invite or invite.is_used or invite.is_expired:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This invite link is invalid or has expired. Ask your Pineview contact for a new one.",
        )

    display_name = payload.name.strip() or payload.email.split("@")[0].title()
    client = _get_supabase_admin()
    access = _invite_access(invite)

    app_metadata: dict = {
        "role": RoleEnum.client.value,
        "name": display_name,
        **build_scope_app_metadata(access),
    }

    try:
        client.auth.admin.create_user(
            {
                "email": payload.email,
                "password": payload.password,
                "email_confirm": False,
                "app_metadata": app_metadata,
                "user_metadata": {"name": display_name},
            }
        )
    except Exception as exc:
        msg = str(exc).lower()
        if "already been registered" in msg or "already exists" in msg or "duplicate" in msg:
            # Don't burn the invite on a duplicate-email attempt — let the
            # admin's link keep working for the real intended recipient.
            logger.info("Duplicate client signup attempt for %s", mask_email(payload.email))
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="An account with this email already exists. Try logging in, or use 'Forgot password'.",
            )
        logger.exception(
            "Error creating client user %s: %s (code=%s status=%s)",
            mask_email(payload.email),
            type(exc).__name__,
            getattr(exc, "code", None),
            getattr(exc, "status", None),
        )
        detail = f"Could not create account ({type(exc).__name__}): {exc}"
        if "database error" in msg:
            detail += (
                " This usually means a leftover Supabase Auth account already exists for this "
                "email — contact Pineview instead of retrying with the same address."
            )
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=detail)

    # Burn the token now that the account exists — a retry (e.g. the
    # confirmation-link step below failing) should not let the same link
    # create a second account.
    invite.used_at = datetime.utcnow()
    invite.used_by_email = payload.email
    db.commit()

    confirmation_url: Optional[str] = None
    try:
        link_result = client.auth.admin.generate_link(
            {
                "type": "signup",
                "email": payload.email,
                "password": payload.password,
                "options": {"redirect_to": f"{settings.frontend_url.rstrip('/')}/"},
            }
        )
        props = getattr(link_result, "properties", None) or {}
        if isinstance(props, dict):
            confirmation_url = props.get("action_link") or props.get("action_url")
        else:
            confirmation_url = getattr(props, "action_link", None)
        if not confirmation_url and isinstance(link_result, dict):
            inner = link_result.get("properties") or link_result.get("data") or {}
            if isinstance(inner, dict):
                confirmation_url = inner.get("action_link") or inner.get("action_url")
    except Exception as exc:
        logger.exception("Error generating confirmation link for %s: %s", mask_email(payload.email), type(exc).__name__)

    if not confirmation_url:
        logger.warning("No confirmation link returned for client signup %s", mask_email(payload.email))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Account created but confirmation email could not be prepared. Contact Pineview.",
        )

    try:
        await send_signup_confirmation(payload.email, confirmation_url, display_name)
    except Exception as exc:
        logger.exception("Error sending confirmation email to %s: %s", mask_email(payload.email), type(exc).__name__)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Account created but confirmation email failed to send. Contact Pineview.",
        )

    logger.info(
        "Client signup via invite for %s (clients=%s)",
        mask_email(payload.email),
        display_client_names(access),
    )
    return ClientSignupResponse(message="Check your email to confirm your account.")
