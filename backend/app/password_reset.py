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

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy.orm import Session
from supabase import create_client

from app.config import get_settings
from app.database import get_db
from app.email_service import send_password_reset_code
from app.models import PasswordResetCode

router = APIRouter(prefix="/api/auth", tags=["password-reset"])

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


# ── Endpoints ───────────────────────────────────────────────────────


@router.post(
    "/forgot-password",
    response_model=RequestResetCodeResponse,
    status_code=status.HTTP_200_OK,
)
async def request_reset_code(
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
        
    except Exception as e:
        # Log error but don't expose details to client
        print(f"Error sending password reset code to {payload.email}: {e}")
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
def verify_reset_code(
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
def reset_password(
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
    except Exception as e:
        print(f"Error resetting password for {reset_code.email}: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to reset password. Please try again.",
        )
    
    return ResetPasswordResponse(
        message="Password reset successfully. You can now log in with your new password.",
    )
