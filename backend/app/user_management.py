"""User management endpoints using Supabase Admin API.

These endpoints allow admins to create, list, update, and delete
Supabase Auth users directly from the Pineview Maps admin panel.
"""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, EmailStr
from sqlalchemy.orm import Session
from supabase import create_client

from app.auth import require_roles
from app.config import get_settings
from app.database import get_db
from app.email_service import send_password_reset_code
from app.models import PasswordResetCode, RoleEnum

router = APIRouter(prefix="/api/admin/users", tags=["user-management"])

settings = get_settings()


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
    )


# ── Endpoints ───────────────────────────────────────────────────────


@router.get(
    "",
    response_model=list[UserResponse],
    dependencies=[Depends(require_roles(RoleEnum.admin))],
)
def list_users() -> list[UserResponse]:
    """List all Supabase Auth users."""
    client = get_supabase_admin()
    try:
        result = client.auth.admin.list_users()
        # result is a list of User objects
        users = result if isinstance(result, list) else (result or [])
        return [_format_user(u) for u in users]
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
        print(f"[USER_MGMT] Creating user: {payload.email} with role {payload.role.value}")
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
        print(f"[USER_MGMT] User created successfully: {result.user.id}")
        return _format_user(result.user)
    except Exception as exc:
        error_msg = str(exc)
        print(f"[USER_MGMT] Error creating user: {error_msg}")
        if "already been registered" in error_msg.lower() or "already exists" in error_msg.lower():
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="A user with this email already exists",
            )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to create user: {error_msg}",
        )


@router.patch(
    "/{user_id}",
    response_model=UserResponse,
    dependencies=[Depends(require_roles(RoleEnum.admin))],
)
def update_user(user_id: str, payload: UserUpdate) -> UserResponse:
    """Update a Supabase Auth user's role or name."""
    client = get_supabase_admin()
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
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to update user: {exc}",
        )


@router.delete(
    "/{user_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_roles(RoleEnum.admin))],
)
def delete_user(user_id: str) -> None:
    """Delete a Supabase Auth user."""
    client = get_supabase_admin()
    try:
        client.auth.admin.delete_user(user_id)
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to delete user: {exc}",
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
        print(f"[USER_MGMT] Email manually confirmed for user {user_id}")
        return _format_user(result.user)
    except Exception as exc:
        print(f"[USER_MGMT] Error confirming email for {user_id}: {exc}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to confirm email: {exc}",
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
    """Trigger a 6-digit password reset code email on behalf of a user.

    Mirrors the user-facing `/api/auth/forgot-password` flow but lets an admin
    initiate it from the User Management panel — useful when a worker can't
    receive or find the existing reset email and is calling for help.
    """
    if db is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Password reset is not available — backend has no database session.",
        )

    # Look up the user's email via Supabase Admin API. We could accept the
    # email as input, but tying the action to user_id keeps the admin UI
    # consistent with the other actions (and prevents typos).
    client = get_supabase_admin()
    try:
        user_result = client.auth.admin.get_user_by_id(user_id)
        user = getattr(user_result, "user", None) or user_result
        email = getattr(user, "email", None)
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"User not found: {exc}",
        )

    if not email:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User has no email address on file.",
        )

    # Mark any unused reset codes for this email as used so the worker can
    # only use the brand-new code (avoids ambiguity if they had requested one
    # themselves earlier).
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

        reset_code = PasswordResetCode(email=email)
        db.add(reset_code)
        db.commit()
        db.refresh(reset_code)
    except Exception as exc:
        db.rollback()
        print(f"[USER_MGMT] DB error issuing reset code for {email}: {exc}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Could not issue reset code. Please try again.",
        )

    try:
        await send_password_reset_code(email, reset_code.code)
    except Exception as exc:
        print(f"[USER_MGMT] SMTP error sending reset code to {email}: {exc}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Reset code generated but email failed to send. Check SMTP config.",
        )

    print(f"[USER_MGMT] Admin-initiated reset code sent to {email}")
    return SimpleMessageResponse(
        message=f"Password reset code sent to {email}. They can use it on the login screen → 'Forgot password'.",
    )
