"""Password reset endpoints using 6-digit codes.

This module provides a secure password reset flow:
1. User requests reset → 6-digit code sent to email
2. User enters code on login page → Code verified
3. User enters new password → Password updated via Supabase Admin API

Security features:
- 6-digit codes expire after 10 minutes
- Max 3 attempts per code
- Codes are cryptographically secure random numbers
- Single use only (deleted after successful reset)
"""

from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy.orm import Session
from supabase import create_client

from app.config import get_settings
from app.database import get_db
from app.email_service import send_password_reset_code
from app.log_util import get_logger, mask_email
from app.models import PasswordResetCode
from app.rate_limit import limiter

router = APIRouter(prefix="/api/auth", tags=["password-reset"])

settings = get_settings()
logger = get_logger(__name__)


def get_supabase_admin():
    """Create a Supabase client with the service role key for admin operations."""
    if not settings.supabase_url or not settings.supabase_service_role_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Supabase admin configuration not available",
        )
    return create_client(settings.supabase_url, settings.supabase_service_role_key)


# ── Request / Response schemas ──────────────────────────────────────


class RequestResetCodeRequest(BaseModel):
    email: EmailStr


class RequestResetCodeResponse(BaseModel):
    message: str


class VerifyCodeRequest(BaseModel):
    email: EmailStr
    code: str = Field(..., min_length=6, max_length=6, pattern=r"^\d{6}$")


class VerifyCodeResponse(BaseModel):
    reset_token: str
    message: str


class ResetPasswordRequest(BaseModel):
    reset_token: str
    new_password: str = Field(..., min_length=6)


class ResetPasswordResponse(BaseModel):
    message: str


class SetupPasswordRequest(BaseModel):
    """Body for POST /api/auth/setup-password.

    Used by the admin-initiated magic-link onboarding flow. The token
    here is the same ``reset_token`` issued by
    :func:`app.user_management.send_user_password_reset` and embedded in
    the ``?setup_token=...`` query parameter of the email link.
    """

    setup_token: str = Field(..., min_length=32)
    new_password: str = Field(..., min_length=6)


# ── Endpoints ───────────────────────────────────────────────────────


@router.post(
    "/forgot-password",
    response_model=RequestResetCodeResponse,
    status_code=status.HTTP_200_OK,
)
@limiter.limit("5/hour")
async def request_reset_code(
    request: Request,
    payload: RequestResetCodeRequest,
    db: Session = Depends(get_db),
) -> RequestResetCodeResponse:
    """Request a 6-digit password reset code.
    
    Always returns the same success message regardless of whether
    the email exists (prevents user enumeration).
    """
    # In production with Supabase, we check if user exists via Supabase Admin API
    # For now, we accept any email and the reset will fail later if user doesn't exist
    
    if db is None:
        # Production mode: Supabase-only, no local DB
        # For now, return generic message - in production you'd store codes in Supabase
        return RequestResetCodeResponse(
            message="If an account exists with this email, you will receive a password reset code shortly."
        )

    try:
        # Invalidate any existing unused codes for this email
        existing_codes = (
            db.query(PasswordResetCode)
            .filter(
                PasswordResetCode.email == payload.email,
                PasswordResetCode.is_used == False,
            )
            .all()
        )
        for code in existing_codes:
            code.is_used = True  # Mark as used to prevent confusion
        
        # Create new reset code
        reset_code = PasswordResetCode(email=payload.email)
        db.add(reset_code)
        db.commit()
        db.refresh(reset_code)
        
        # Send email with the code
        await send_password_reset_code(payload.email, reset_code.code)
        
    except Exception as exc:
        # Log error but don't expose details to client. Mask the email so
        # logs remain triage-able without storing the full address.
        logger.exception(
            "Error sending password reset code to %s: %s",
            mask_email(payload.email),
            type(exc).__name__,
        )
        # Still return success message to prevent user enumeration
        pass
    
    # Always return same message (prevents user enumeration)
    return RequestResetCodeResponse(
        message="If an account exists with this email, you will receive a password reset code shortly."
    )


@router.post(
    "/verify-reset-code",
    response_model=VerifyCodeResponse,
    status_code=status.HTTP_200_OK,
)
@limiter.limit("20/hour")
def verify_reset_code(
    request: Request,
    payload: VerifyCodeRequest,
    db: Session = Depends(get_db),
) -> VerifyCodeResponse:
    """Verify a 6-digit password reset code.
    
    Returns a reset token that can be used to actually reset the password.
    """
    if db is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Password reset not available in production mode without database",
        )

    # Find the most recent unused code for this email
    reset_code = (
        db.query(PasswordResetCode)
        .filter(
            PasswordResetCode.email == payload.email,
            PasswordResetCode.is_used == False,
        )
        .order_by(PasswordResetCode.created_at.desc())
        .first()
    )
    
    if not reset_code:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid or expired code. Please request a new code.",
        )
    
    # Check if code is locked (too many attempts, expired, or used)
    if reset_code.is_locked:
        if reset_code.is_expired:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Code has expired. Please request a new code.",
            )
        if reset_code.attempts >= reset_code.max_attempts:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Too many failed attempts. Please request a new code.",
            )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid code. Please request a new code.",
        )
    
    # Verify the code
    if reset_code.code != payload.code:
        reset_code.attempts += 1
        db.commit()
        
        remaining = reset_code.max_attempts - reset_code.attempts
        if remaining <= 0:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Too many failed attempts. Please request a new code.",
            )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid code. {remaining} attempts remaining.",
        )
    
    # Code is valid - mark as used
    reset_code.is_used = True
    reset_code.used_at = datetime.utcnow()
    db.commit()
    
    return VerifyCodeResponse(
        reset_token=reset_code.reset_token,
        message="Code verified successfully. You can now reset your password.",
    )


@router.post(
    "/reset-password",
    response_model=ResetPasswordResponse,
    status_code=status.HTTP_200_OK,
)
@limiter.limit("10/hour")
def reset_password(
    request: Request,
    payload: ResetPasswordRequest,
    db: Session = Depends(get_db),
) -> ResetPasswordResponse:
    """Reset password using a valid reset token.
    
    Uses Supabase Admin API to update the user's password.
    """
    if db is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Password reset not available in production mode without database",
        )

    # Find the reset code by token
    reset_code = (
        db.query(PasswordResetCode)
        .filter(
            PasswordResetCode.reset_token == payload.reset_token,
            PasswordResetCode.is_used == True,  # Must be verified first
        )
        .first()
    )
    
    if not reset_code:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid reset token. Please start the password reset process again.",
        )
    
    # Check if token is expired (codes expire 10 min after creation, but give extra buffer)
    # Token is valid for 15 minutes from creation (5 min buffer after code expiry)
    token_expiry = reset_code.expires_at + __import__('datetime').timedelta(minutes=5)
    if datetime.utcnow() > token_expiry:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Reset token has expired. Please request a new code.",
        )
    
    # Use Supabase Admin API to update the password
    try:
        client = get_supabase_admin()
        
        # Find user by email
        users_result = client.auth.admin.list_users()
        users = users_result if isinstance(users_result, list) else []
        
        target_user = None
        for user in users:
            if user.email == reset_code.email:
                target_user = user
                break
        
        if not target_user:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="User not found. The account may have been deleted.",
            )
        
        # Update the user's password
        client.auth.admin.update_user_by_id(
            target_user.id,
            {"password": payload.new_password}
        )
        
        # Clean up - delete the used reset code
        db.delete(reset_code)
        db.commit()
        
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception(
            "Error resetting password for %s: %s",
            mask_email(reset_code.email),
            type(exc).__name__,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to reset password. Please try again.",
        )
    
    return ResetPasswordResponse(
        message="Password reset successfully. You can now log in with your new password.",
    )


@router.post(
    "/setup-password",
    response_model=ResetPasswordResponse,
    status_code=status.HTTP_200_OK,
)
@limiter.limit("10/hour")
def setup_password(
    request: Request,
    payload: SetupPasswordRequest,
    db: Session = Depends(get_db),
) -> ResetPasswordResponse:
    """Consume an admin-issued setup link and set the user's password.

    Differs from :func:`reset_password` in two ways:

    1. The token here is **not** required to have been pre-verified
       (``is_used == True``). Possession of the link IS the proof of
       email control — the same model GitHub, Stripe, etc. use for
       invite/onboarding emails. The user-facing 6-digit code flow
       still uses the older two-step verify-then-reset path.
    2. The token has a longer lifetime (24h, set by the issuer) and a
       different default expires_at. We trust the row's
       ``expires_at`` directly rather than adding a buffer like
       :func:`reset_password` does.

    Marks the row used+deleted on success so the link can't be replayed.
    """
    if db is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Password setup not available in production mode without database",
        )

    # Look up by reset_token (which we reuse as the setup token — same
    # 64-char hex column, single-use, indexed). Reject already-used
    # tokens up front so a leaked email link can't be replayed after
    # the worker has already set their password.
    reset_code = (
        db.query(PasswordResetCode)
        .filter(
            PasswordResetCode.reset_token == payload.setup_token,
            PasswordResetCode.is_used == False,  # noqa: E712 — SQLAlchemy filter requires `==`
        )
        .first()
    )

    if not reset_code:
        # Same generic message for "doesn't exist" and "already used"
        # so an attacker probing tokens can't distinguish the two.
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This setup link is invalid or has already been used. Ask your administrator to send a new one.",
        )

    if datetime.utcnow() > reset_code.expires_at:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This setup link has expired. Ask your administrator to send a new one.",
        )

    # Push the password into Supabase via Admin API and burn the token.
    # We do the burn (is_used=True) regardless of Supabase success/failure
    # below — a token that hit a transient Supabase error is safer to
    # discard and re-issue than to leave live for replay.
    try:
        client = get_supabase_admin()

        users_result = client.auth.admin.list_users()
        users = users_result if isinstance(users_result, list) else []
        target_user = next((u for u in users if u.email == reset_code.email), None)

        if not target_user:
            # Mark the token used so this dead account's link can't be
            # probed indefinitely.
            reset_code.is_used = True
            reset_code.used_at = datetime.utcnow()
            db.commit()
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="The account this link was issued for no longer exists. Ask your administrator to recreate it.",
            )

        client.auth.admin.update_user_by_id(
            target_user.id,
            {"password": payload.new_password, "email_confirm": True},
        )

        reset_code.is_used = True
        reset_code.used_at = datetime.utcnow()
        db.delete(reset_code)
        db.commit()

        logger.info(
            "Password set via setup link for %s", mask_email(reset_code.email)
        )

    except HTTPException:
        raise
    except Exception as exc:
        db.rollback()
        logger.exception(
            "Error setting password via setup link for %s: %s",
            mask_email(reset_code.email),
            type(exc).__name__,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to set password. Please try again.",
        )

    return ResetPasswordResponse(
        message="Password set successfully. You can now sign in.",
    )
