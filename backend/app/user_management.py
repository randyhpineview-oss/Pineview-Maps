"""User management endpoints using Supabase Admin API.

These endpoints allow admins to create, list, update, and delete
Supabase Auth users directly from the Pineview Maps admin panel.
"""

from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, EmailStr
from sqlalchemy.orm import Session
from supabase import create_client

from app.auth import get_current_user, is_dev_email, require_roles
from app.config import get_settings
from app.database import get_db
from app.email_service import send_password_setup_link
from app.log_util import get_logger, mask_email, short_id
from app.models import PasswordResetCode, RoleEnum, User

router = APIRouter(prefix="/api/admin/users", tags=["user-management"])

# Roster router: minimal user list available to ANY authenticated user.
# Powers crew-pickers (Hydroseed Daily roster, T&M crew, etc.) for non-admin
# roles that can't hit /api/admin/users. Returns only the local `users` table
# (id/name/email/role/created_at) — no Supabase-Auth metadata, so this is
# both cheap and information-light.
roster_router = APIRouter(prefix="/api/users", tags=["user-roster"])


class RosterUser(BaseModel):
    id: int
    name: str
    email: str
    role: str
    created_at: str


@roster_router.get("/roster", response_model=list[RosterUser])
def list_roster(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[RosterUser]:
    """Minimal user list for in-app pickers (any authenticated role).

    Mirrors the shape `cachedUsers` consumers expect (HydroseedDailyRecord,
    crew picker, etc.) without exposing Supabase-Auth fields.
    """
    rows = db.query(User).order_by(User.name.asc()).all()
    # Hide the dev account from everyone except the dev themselves.
    if not is_dev_email(getattr(current_user, "email", None)):
        rows = [u for u in rows if not is_dev_email(u.email)]
    return [
        RosterUser(
            id=u.id,
            name=u.name or "",
            email=u.email or "",
            role=u.role.value if hasattr(u.role, "value") else str(u.role),
            created_at=u.created_at.isoformat() if u.created_at else "",
        )
        for u in rows
    ]

settings = get_settings()
logger = get_logger(__name__)

def _guard_dev_account(client, user_id: str, current_user: User) -> None:
    """403 if `user_id` is the dev account and the requester isn't the dev."""
    if is_dev_email(getattr(current_user, "email", None)):
        return
    try:
        result = client.auth.admin.get_user_by_id(user_id)
        target = getattr(result, "user", None) or result
        target_email = getattr(target, "email", None)
    except Exception:
        return  # target lookup failed — let the main handler surface the error
    if is_dev_email(target_email):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This account is protected and cannot be modified.",
        )


def get_supabase_admin():
    """Create a Supabase client with the service role key for admin operations."""
    if not settings.supabase_url or not settings.supabase_service_role_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Supabase admin configuration not available",
        )
    return create_client(settings.supabase_url, settings.supabase_service_role_key)


# ── Request / Response schemas ──────────────────────────────────────


class UserCreate(BaseModel):
    email: str
    password: str
    role: RoleEnum = RoleEnum.worker
    name: str = ""


class UserUpdate(BaseModel):
    role: Optional[RoleEnum] = None
    name: Optional[str] = None


class UserResponse(BaseModel):
    id: str
    email: str
    role: str
    name: str
    created_at: str
    last_sign_in_at: Optional[str] = None
    # Whether the user has clicked the link in their signup-confirmation email.
    # Workers stuck at "email not confirmed" can be unblocked by an admin via
    # POST /api/admin/users/{id}/confirm-email; the UI shows the button only
    # when this is None / empty.
    email_confirmed_at: Optional[str] = None
    # Soft delete timestamp - if set, user is deleted but data preserved
    deleted_at: Optional[str] = None


def _format_user(user) -> UserResponse:
    """Convert a Supabase auth user object to our response format."""
    metadata = user.user_metadata or {}
    return UserResponse(
        id=user.id,
        email=user.email or "",
        role=metadata.get("role", "worker"),
        name=metadata.get("name", user.email.split("@")[0].title() if user.email else ""),
        created_at=str(user.created_at) if user.created_at else "",
        last_sign_in_at=str(user.last_sign_in_at) if user.last_sign_in_at else None,
        email_confirmed_at=str(user.email_confirmed_at) if getattr(user, "email_confirmed_at", None) else None,
        deleted_at=str(user.deleted_at) if getattr(user, "deleted_at", None) else None,
    )


# ── Endpoints ───────────────────────────────────────────────────────


@router.get(
    "",
    response_model=list[UserResponse],
    dependencies=[Depends(require_roles(RoleEnum.admin))],
)
def list_users(current_user: User = Depends(get_current_user)) -> list[UserResponse]:
    """List all Supabase Auth users (excluding soft-deleted)."""
    client = get_supabase_admin()
    try:
        result = client.auth.admin.list_users()
        # result is a list of User objects
        users = result if isinstance(result, list) else (result or [])
        # Filter out soft-deleted users
        active_users = [u for u in users if not getattr(u, "deleted_at", None)]
        # Hide the dev account from everyone except the dev themselves.
        if not is_dev_email(getattr(current_user, "email", None)):
            active_users = [u for u in active_users if not is_dev_email(getattr(u, "email", None))]
        return [_format_user(u) for u in active_users]
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to list users: {exc}",
        )


@router.post(
    "",
    response_model=UserResponse,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_roles(RoleEnum.admin))],
)
def create_user(payload: UserCreate) -> UserResponse:
    """Create a new Supabase Auth user with a role."""
    client = get_supabase_admin()
    try:
        logger.info(
            "Creating user %s with role %s",
            mask_email(payload.email),
            payload.role.value,
        )
        result = client.auth.admin.create_user(
            {
                "email": payload.email,
                "password": payload.password,
                "email_confirm": True,
                "user_metadata": {
                    "role": payload.role.value,
                    "name": payload.name or payload.email.split("@")[0].title(),
                },
            }
        )
        logger.info("User created successfully: %s", short_id(result.user.id))
        return _format_user(result.user)
    except Exception as exc:
        error_msg = str(exc)
        if "already been registered" in error_msg.lower() or "already exists" in error_msg.lower():
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="A user with this email already exists",
            )
        logger.exception(
            "Error creating user %s: %s",
            mask_email(payload.email),
            type(exc).__name__,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create user",
        )


@router.patch(
    "/{user_id}",
    response_model=UserResponse,
    dependencies=[Depends(require_roles(RoleEnum.admin))],
)
def update_user(
    user_id: str,
    payload: UserUpdate,
    current_user: User = Depends(get_current_user),
) -> UserResponse:
    """Update a Supabase Auth user's role or name."""
    client = get_supabase_admin()
    _guard_dev_account(client, user_id, current_user)
    try:
        # Build the metadata update
        update_data: dict = {}
        metadata_updates: dict = {}

        if payload.role is not None:
            metadata_updates["role"] = payload.role.value
        if payload.name is not None:
            metadata_updates["name"] = payload.name

        if metadata_updates:
            update_data["user_metadata"] = metadata_updates

        if not update_data:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="No fields to update",
            )

        result = client.auth.admin.update_user_by_id(user_id, update_data)
        return _format_user(result.user)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception(
            "Error updating user %s: %s", short_id(user_id), type(exc).__name__
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to update user",
        )


@router.delete(
    "/{user_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_roles(RoleEnum.admin))],
)
def delete_user(
    user_id: str,
    current_user: User = Depends(get_current_user),
) -> None:
    """Delete a Supabase Auth user (soft delete - preserves data but disables login)."""
    client = get_supabase_admin()
    _guard_dev_account(client, user_id, current_user)
    try:
        client.auth.admin.delete_user(user_id, should_soft_delete=True)
    except Exception as exc:
        logger.exception(
            "Error deleting user %s: %s", short_id(user_id), type(exc).__name__
        )
        error_detail = str(exc)
        if "Database error" in error_detail:
            error_detail = (
                "Cannot delete user - they likely have related records in the database. "
                "Please delete their associated data first (e.g., spray records, checkins, etc.) "
                f"Original error: {error_detail}"
            )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to delete user: {error_detail}",
        )


# ── Admin recovery actions ──────────────────────────────────────────


class SimpleMessageResponse(BaseModel):
    message: str


@router.post(
    "/{user_id}/confirm-email",
    response_model=UserResponse,
    dependencies=[Depends(require_roles(RoleEnum.admin))],
)
def confirm_user_email(user_id: str) -> UserResponse:
    """Manually confirm a user's email address.

    Unblocks workers who scanned the signup QR but never clicked the link in
    their inbox — without this, Supabase rejects login and password reset
    with "email not confirmed". Avoids the delete-and-recreate workaround.
    """
    client = get_supabase_admin()
    try:
        result = client.auth.admin.update_user_by_id(
            user_id,
            {"email_confirm": True},
        )
        logger.info("Email manually confirmed for user %s", short_id(user_id))
        return _format_user(result.user)
    except Exception as exc:
        logger.exception(
            "Error confirming email for user %s: %s",
            short_id(user_id),
            type(exc).__name__,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to confirm email",
        )


@router.post(
    "/{user_id}/send-password-reset",
    response_model=SimpleMessageResponse,
    dependencies=[Depends(require_roles(RoleEnum.admin))],
)
async def send_user_password_reset(
    user_id: str,
    db: Session = Depends(get_db),
) -> SimpleMessageResponse:
    """Email the user a one-tap **password setup link** (admin-initiated).

    Generates a single-use, 24-hour ``setup_token`` (stored in
    ``PasswordResetCode.reset_token``) and emails a link of the form
    ``{frontend_url}/?setup_token=...`` via :func:`send_password_setup_link`.
    The frontend's login page detects that query param on load and shows
    a "Set Your Password" screen which posts to ``/api/auth/setup-password``.

    Why a magic link instead of a 6-digit code?
        The previous admin button issued a 6-digit code, but the only UI
        for entering that code lives behind the user-facing
        "Forgot password" → "Send Reset Code" flow — and that flow
        invalidates pre-existing codes the moment the worker requests a
        new one. So an admin-issued code was never actually usable. A
        magic link is single-step (click → set password → done) and
        doubles as the new-account onboarding flow.

    The endpoint URL is unchanged for frontend back-compat; only the
    behavior and the success message change.
    """
    if db is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Password setup is not available — backend has no database session.",
        )

    # Look up the user's email + display name via Supabase Admin API.
    # The display name is shown in the email greeting ("Hi <name> — set
    # your password"); we fall back to the email's local part if missing.
    client = get_supabase_admin()
    try:
        user_result = client.auth.admin.get_user_by_id(user_id)
        user = getattr(user_result, "user", None) or user_result
        email = getattr(user, "email", None)
        user_metadata = getattr(user, "user_metadata", None) or {}
        display_name = user_metadata.get("name") if isinstance(user_metadata, dict) else None
    except Exception as exc:
        logger.exception(
            "Error looking up user %s: %s", short_id(user_id), type(exc).__name__
        )
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found",
        )

    if not email:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User has no email address on file.",
        )

    # Invalidate any unused tokens still outstanding for this email so the
    # newest setup link is the only one that can be redeemed. Covers the
    # "admin clicked twice" and "worker also requested a 6-digit code"
    # cases — both paths share the PasswordResetCode table.
    try:
        existing_codes = (
            db.query(PasswordResetCode)
            .filter(
                PasswordResetCode.email == email,
                PasswordResetCode.is_used == False,  # noqa: E712 — SQLAlchemy filter requires `==`
            )
            .all()
        )
        for code in existing_codes:
            code.is_used = True

        # Setup links live for 24h (vs 10min for the user-facing 6-digit
        # codes) because admins typically issue them in advance of
        # onboarding a new worker, who may not check email immediately.
        reset_code = PasswordResetCode(
            email=email,
            expires_at=datetime.utcnow() + timedelta(hours=24),
        )
        db.add(reset_code)
        db.commit()
        db.refresh(reset_code)
    except Exception as exc:
        db.rollback()
        logger.exception(
            "DB error issuing setup link for %s: %s",
            mask_email(email),
            type(exc).__name__,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Could not issue setup link. Please try again.",
        )

    # Catch the "no email transport configured" silent-success case before
    # calling the email service — otherwise the worker silently never
    # gets a link and the admin thinks it worked.
    from app.email_service import email_transport_configured
    if not email_transport_configured():
        logger.warning(
            "No email transport configured — setup link for %s not delivered",
            mask_email(email),
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                "Email is not configured on the server. Set RESEND_API_KEY + "
                "RESEND_FROM_EMAIL (recommended on Render) or SMTP_USER + "
                "SMTP_PASSWORD, then redeploy."
            ),
        )

    # Build the one-tap URL. ``frontend_url`` already points at the
    # production site (e.g. https://pineviewmaps.com) — we just append
    # ``?setup_token=...``. The login page handles the rest on mount.
    setup_url = f"{settings.frontend_url.rstrip('/')}/?setup_token={reset_code.reset_token}"

    try:
        await send_password_setup_link(email, setup_url, display_name)
    except Exception as exc:
        logger.exception(
            "Email error sending setup link to %s: %s",
            mask_email(email),
            type(exc).__name__,
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Setup link generated but email failed to send. Check email transport configuration.",
        )

    logger.info("Admin-initiated setup link sent to %s", mask_email(email))
    return SimpleMessageResponse(
        message=f"Password setup link sent to {email}. They'll get a one-tap link that lets them set their password and sign in.",
    )
