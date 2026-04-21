"""Worker self-signup via QR-code invite link.

Flow:
  1. Admin displays QR (see GET /api/admin/signup-invite-url) in the office.
  2. New worker scans QR → frontend opens /?invite=<secret>.
  3. Frontend shows signup form → POST /api/auth/signup with {invite_code, name, email, password}.
  4. Backend validates the invite against settings.signup_invite_secret, creates
     the Supabase user with email_confirm=False and role="worker", generates a
     confirmation link via Admin API, and emails it via our existing Gmail SMTP.
  5. Worker clicks the link → Supabase marks them confirmed → they can log in.

Security:
  - Constant-time secret comparison (hmac.compare_digest).
  - If signup_invite_secret is unset, every request is rejected (prevents an
    accidentally-wide-open signup endpoint on a misconfigured deploy).
  - Role is always forced to "worker" regardless of request body — admins
    promote later via the existing User Management panel.
  - Generic success/error messages to prevent user enumeration.
"""

import hmac
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, EmailStr, Field
from supabase import create_client

from app.auth import require_roles
from app.config import get_settings
from app.email_service import send_signup_confirmation
from app.models import RoleEnum

router = APIRouter(tags=["worker-signup"])

settings = get_settings()


def _get_supabase_admin():
    """Create a Supabase client with the service role key for admin operations."""
    if not settings.supabase_url or not settings.supabase_service_role_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Supabase admin configuration not available",
        )
    return create_client(settings.supabase_url, settings.supabase_service_role_key)


# ── Request / Response schemas ──────────────────────────────────────


class SignupRequest(BaseModel):
    invite_code: str = Field(..., min_length=1, max_length=256)
    name: str = Field(..., min_length=1, max_length=120)
    email: EmailStr
    password: str = Field(..., min_length=6, max_length=128)


class SignupResponse(BaseModel):
    message: str


class InviteUrlResponse(BaseModel):
    url: Optional[str] = None
    configured: bool


# ── Public endpoint ─────────────────────────────────────────────────


@router.post(
    "/api/auth/signup",
    response_model=SignupResponse,
    status_code=status.HTTP_200_OK,
)
async def worker_signup(payload: SignupRequest) -> SignupResponse:
    """Create a new worker account gated by the QR-code invite secret.

    Returns a generic success message whether or not the email already exists
    (prevents enumeration). Always forces role="worker".
    """
    # Fail closed: an unset secret means self-signup is disabled entirely.
    if not settings.signup_invite_secret:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Signup is not currently enabled. Contact your administrator.",
        )

    # Constant-time compare so timing attacks can't recover the secret.
    if not hmac.compare_digest(payload.invite_code, settings.signup_invite_secret):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Invalid or expired invite link. Ask your administrator for a new QR code.",
        )

    display_name = payload.name.strip() or payload.email.split("@")[0].title()

    client = _get_supabase_admin()

    # Create the user. email_confirm=False means they must click the link in
    # their inbox before they can log in. Role is hard-coded to "worker" —
    # admins promote later via /api/admin/users.
    try:
        create_result = client.auth.admin.create_user(
            {
                "email": payload.email,
                "password": payload.password,
                "email_confirm": False,
                "user_metadata": {
                    "role": RoleEnum.worker.value,
                    "name": display_name,
                },
            }
        )
    except Exception as exc:
        msg = str(exc).lower()
        # Duplicate email: return the same generic success the happy path uses
        # so an attacker can't probe for existing accounts.
        if "already been registered" in msg or "already exists" in msg or "duplicate" in msg:
            print(f"[SIGNUP] Duplicate signup attempt for {payload.email} (silently accepted)")
            return SignupResponse(
                message="Check your email to confirm your account.",
            )
        print(f"[SIGNUP] Error creating user for {payload.email}: {exc}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Could not create account. Please try again.",
        )

    # Generate a signup confirmation link via the Admin API, then email it
    # through our existing Gmail SMTP pipeline (send_password_reset_code-style).
    confirmation_url: Optional[str] = None
    try:
        link_result = client.auth.admin.generate_link(
            {
                "type": "signup",
                "email": payload.email,
                "password": payload.password,
                "options": {
                    "redirect_to": f"{settings.frontend_url.rstrip('/')}/",
                },
            }
        )
        # supabase-py returns an object with .properties.action_link; fall back
        # to a few likely shapes since response format varies across versions.
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
        print(f"[SIGNUP] Error generating confirmation link for {payload.email}: {exc}")

    if not confirmation_url:
        # User was created but we couldn't mint a link — surface a 500 so the
        # admin can investigate rather than silently leaving the worker stuck.
        print(f"[SIGNUP] No confirmation link returned for {payload.email}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Account created but confirmation email could not be prepared. Contact your administrator.",
        )

    try:
        await send_signup_confirmation(payload.email, confirmation_url, display_name)
    except Exception as exc:
        print(f"[SIGNUP] Error sending confirmation email to {payload.email}: {exc}")
        # Don't expose SMTP details to the client; but do signal a failure so
        # the worker can retry (admin may need to fix SMTP config).
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Account created but confirmation email failed to send. Contact your administrator.",
        )

    return SignupResponse(message="Check your email to confirm your account.")


# ── Admin endpoint ─────────────────────────────────────────────────


@router.get(
    "/api/admin/signup-invite-url",
    response_model=InviteUrlResponse,
    dependencies=[Depends(require_roles(RoleEnum.admin))],
)
def get_signup_invite_url() -> InviteUrlResponse:
    """Return the full QR-code invite URL for the admin panel to render.

    Admin-only so the secret never reaches non-admin clients. The secret
    itself lives only in the backend env var; this endpoint stitches it
    together with FRONTEND_URL on demand.
    """
    if not settings.signup_invite_secret:
        return InviteUrlResponse(url=None, configured=False)

    base = settings.frontend_url.rstrip("/")
    url = f"{base}/?invite={settings.signup_invite_secret}"
    return InviteUrlResponse(url=url, configured=True)
