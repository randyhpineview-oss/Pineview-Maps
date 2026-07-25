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

import secrets

from app.auth import MANAGES_PINS, get_current_user, is_dev_email, require_roles, _stable_user_id
from app.config import get_settings
from app.database import get_db
from app.email_service import email_transport_configured, send_password_setup_link
from app.log_util import get_logger, mask_email, short_id
from app.models import ClientInvite, PasswordResetCode, RoleEnum, User

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
    rows = db.query(User).filter(User.is_active.is_(True)).order_by(User.name.asc()).all()
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
    # Only meaningful for existing role=="client" accounts — lets an admin
    # re-scope an already-created client without recreating the account.
    # Rejected (400) if the target user isn't currently a client — use
    # invite-client to create one.
    client_name: Optional[str] = None
    client_areas: Optional[list[str]] = None


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
    # Only meaningful when role == "client". See models.py::User for semantics.
    client_name: Optional[str] = None
    client_areas: Optional[list[str]] = None


def _format_user(user) -> UserResponse:
    """Convert a Supabase auth user object to our response format.

    SECURITY: role/name/client-scope are read from `app_metadata` — the
    only field the Supabase Admin API (service-role key) can write, and
    the only field `app/auth.py` trusts for authorization. `user_metadata`
    is user-editable and is only used here as a last-resort display
    fallback for legacy rows that haven't been migrated yet (see
    `scripts/migrate_roles_to_app_metadata.py`); it is never treated as a
    source of privilege.
    """
    app_metadata = user.app_metadata or {}
    user_metadata = user.user_metadata or {}
    role = app_metadata.get("role") or user_metadata.get("role") or "worker"
    name = (
        app_metadata.get("name")
        or user_metadata.get("name")
        or (user.email.split("@")[0].title() if user.email else "")
    )
    return UserResponse(
        id=user.id,
        email=user.email or "",
        role=role,
        name=name,
        created_at=str(user.created_at) if user.created_at else "",
        last_sign_in_at=str(user.last_sign_in_at) if user.last_sign_in_at else None,
        email_confirmed_at=str(user.email_confirmed_at) if getattr(user, "email_confirmed_at", None) else None,
        deleted_at=str(user.deleted_at) if getattr(user, "deleted_at", None) else None,
        client_name=app_metadata.get("client_name"),
        client_areas=app_metadata.get("client_areas") or None,
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
    """Create a new Supabase Auth user with a role.

    Role/name are written to `app_metadata` (admin-only, via this
    service-role client) — never `user_metadata`, which the user could
    edit themselves. See `_format_user` and `app/auth.py`.
    """
    if payload.role == RoleEnum.client:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Use POST /api/admin/users/invite-client to create a client account "
            "— it requires a client_name and sends the setup-link email.",
        )
    client = get_supabase_admin()
    try:
        logger.info(
            "Creating user %s with role %s",
            mask_email(payload.email),
            payload.role.value,
        )
        display_name = payload.name or payload.email.split("@")[0].title()
        result = client.auth.admin.create_user(
            {
                "email": payload.email,
                "password": payload.password,
                "email_confirm": True,
                "app_metadata": {
                    "role": payload.role.value,
                    "name": display_name,
                },
                # Harmless display-only mirror — never trusted for authorization.
                "user_metadata": {"name": display_name},
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


def _find_local_user(db: Session, user_id: str, email: Optional[str]) -> Optional[User]:
    """Locate the local `users` row for a Supabase user id.

    Email first (it's the unique column and survives id-scheme changes), then
    the deterministic hash of the Supabase UUID that `auth.py` inserts under.
    """
    if db is None:
        return None
    if email:
        found = db.query(User).filter(User.email == email).first()
        if found is not None:
            return found
    return db.query(User).filter(User.id == _stable_user_id(user_id)).first()


def _mirror_client_scope_locally(
    db: Session,
    user_id: str,
    email: Optional[str],
    client_name: Optional[str],
    client_areas: Optional[list[str]],
) -> None:
    """Copy a client's freshly-saved scope onto their local `users` row.

    This is what makes an admin's edit visible to a signed-in client
    immediately: `get_current_user` reads scope off this row in preference to
    the (now stale) `app_metadata` baked into their JWT.

    A missing local row is fine and silent — the client has never hit an
    authenticated endpoint, so their first request will seed the row from a
    freshly-minted JWT that already carries the new scope. A genuine DB error,
    though, is surfaced as a 500: `_upsert_supabase_user` deliberately stops
    syncing client scope from the JWT, so a silently-skipped write would leave
    the client pinned to their old scope indefinitely. The Supabase write has
    already landed and this whole handler is idempotent, so retrying the PATCH
    is the fix.
    """
    try:
        local_user = _find_local_user(db, user_id, email)
        if local_user is None:
            return
        local_user.client_name = client_name
        local_user.client_areas = client_areas or None
        db.commit()
    except Exception as exc:
        try:
            db.rollback()
        except Exception:
            pass
        logger.exception(
            "Failed to mirror client scope onto local row for %s: %s",
            short_id(user_id),
            type(exc).__name__,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=(
                "Saved in Supabase but the local scope update failed, so the change may not "
                "reach the client until they sign in again. Please retry."
            ),
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
    db: Session = Depends(get_db),
) -> UserResponse:
    """Update a Supabase Auth user's role or name.

    Writes to `app_metadata` — see `create_user` docstring for why.
    Changing a user's role AWAY from `client` here does not clear
    `client_name`/`client_areas` from app_metadata, but that's harmless:
    `app/auth.py` only reads those fields when `role == client`.

    A client-scope change is ALSO mirrored onto the local `users` row so it
    takes effect on the client's very next request instead of waiting for
    their JWT to refresh. See `app/auth.py::_upsert_supabase_user`.
    """
    if payload.role == RoleEnum.client:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Changing a role to 'client' isn't supported here — invite a new client "
            "account instead via POST /api/admin/users/invite-client.",
        )
    client = get_supabase_admin()
    _guard_dev_account(client, user_id, current_user)
    try:
        # Fetch the current app_metadata so a partial update (e.g. name
        # only) doesn't clobber the other fields — Supabase's admin API
        # replaces the whole app_metadata dict, it doesn't merge.
        current = client.auth.admin.get_user_by_id(user_id)
        current_user_obj = getattr(current, "user", None) or current
        existing_app_metadata = dict(getattr(current_user_obj, "app_metadata", None) or {})

        if payload.client_name is not None or payload.client_areas is not None:
            if existing_app_metadata.get("role") != RoleEnum.client.value:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="client_name/client_areas can only be set on an existing client account.",
                )

        if payload.role is not None:
            existing_app_metadata["role"] = payload.role.value
        if payload.name is not None:
            existing_app_metadata["name"] = payload.name
        if payload.client_name is not None:
            trimmed = payload.client_name.strip()
            if not trimmed:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="client_name cannot be empty")
            existing_app_metadata["client_name"] = trimmed
        if payload.client_areas is not None:
            cleaned = [a.strip() for a in payload.client_areas if isinstance(a, str) and a.strip()]
            existing_app_metadata["client_areas"] = cleaned or None

        if (
            payload.role is None
            and payload.name is None
            and payload.client_name is None
            and payload.client_areas is None
        ):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="No fields to update",
            )

        update_data: dict = {"app_metadata": existing_app_metadata}
        if payload.name is not None:
            # Harmless display-only mirror — never trusted for authorization.
            update_data["user_metadata"] = {"name": payload.name}

        result = client.auth.admin.update_user_by_id(user_id, update_data)

        if payload.client_name is not None or payload.client_areas is not None:
            _mirror_client_scope_locally(
                db,
                user_id=user_id,
                email=getattr(current_user_obj, "email", None),
                client_name=existing_app_metadata.get("client_name"),
                client_areas=existing_app_metadata.get("client_areas"),
            )

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


def _purge_client_local_data(
    db: Session,
    local_user: Optional[User],
    email: Optional[str],
) -> None:
    """Remove a hard-deleted client's local footprint so a re-invite starts clean.

    Deletes the local `users` row outright plus the two email-keyed artifacts a
    client account leaves behind: outstanding password-setup codes (Flow A) and
    the invite row their signup consumed (Flow B). Invites they created
    themselves shouldn't exist — creating one needs a pin-managing role — but
    `client_invites.created_by_user_id` is a nullable FK onto `users.id`, so we
    clear it rather than let it block the delete.

    If the users row still can't be deleted (some table we don't know about
    referencing it), fall back to `is_active=False`. A client with linked rows
    is not a reason to hand the admin a 500 — the account still needs to stop
    working, and the residual email can be cleared by hand.
    """
    if db is None:
        return
    try:
        if email:
            db.query(PasswordResetCode).filter(PasswordResetCode.email == email).delete(
                synchronize_session=False
            )
            db.query(ClientInvite).filter(ClientInvite.used_by_email == email).delete(
                synchronize_session=False
            )
        if local_user is not None:
            db.query(ClientInvite).filter(
                ClientInvite.created_by_user_id == local_user.id
            ).update({ClientInvite.created_by_user_id: None}, synchronize_session=False)
            db.delete(local_user)
        db.commit()
    except Exception as exc:
        logger.warning(
            "Hard delete of local client row failed (%s) — deactivating instead",
            type(exc).__name__,
        )
        try:
            db.rollback()
        except Exception:
            pass
        if local_user is None:
            return
        try:
            # Re-read: the rolled-back session may hold a stale/expunged instance.
            fallback = db.query(User).filter(User.id == local_user.id).first()
            if fallback is not None:
                fallback.is_active = False
                db.commit()
        except Exception:
            try:
                db.rollback()
            except Exception:
                pass
            logger.exception("Could not deactivate local client row after failed hard delete")


@router.delete(
    "/{user_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_roles(RoleEnum.admin))],
)
def delete_user(
    user_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    """Delete a Supabase Auth user.

    Clients are HARD-deleted (Supabase Auth row and local `users` row both
    removed) so the email is freed for a later re-invite. A soft-deleted
    Supabase row keeps its email reserved, which is what produces the
    "Database error creating new user" failure when the same contact is
    invited again the following season.

    Every other role is soft-deleted as before: staff ids are referenced by
    sites, spray records, check-ins, quotes and T&M tickets — some of those
    columns are NOT NULL — so removing the row would either fail outright or
    orphan work history that still needs to say who did the work.
    """
    client = get_supabase_admin()
    _guard_dev_account(client, user_id, current_user)
    try:
        # Capture the email and role BEFORE deleting. After deletion, Supabase may
        # not return the user (or may omit the email), leaving the local users
        # row active and causing the deleted account to keep appearing in crew
        # pickers and roster lists.
        target_email = None
        target_role = None
        try:
            result = client.auth.admin.get_user_by_id(user_id)
            target = getattr(result, "user", None) or result
            target_email = getattr(target, "email", None)
            target_app_metadata = getattr(target, "app_metadata", None) or {}
            if isinstance(target_app_metadata, dict):
                target_role = target_app_metadata.get("role")
        except Exception:
            pass

        # Only hard-delete on a POSITIVE identification as a client. If the
        # lookup above failed we don't know the role, and soft delete is the
        # safe answer — a staff account wrongly hard-deleted takes their work
        # history's attribution with it, while a client left soft-deleted just
        # means the admin has to clear the email manually later.
        # `is_dev_email` is belt-and-suspenders: the dev account is an admin so
        # it can't reach this branch anyway, but _guard_dev_account lets the dev
        # act on their own account and must never be bypassed by a new path.
        hard_delete = target_role == RoleEnum.client.value and not is_dev_email(target_email)

        client.auth.admin.delete_user(user_id, should_soft_delete=not hard_delete)

        local_user = _find_local_user(db, user_id, target_email)

        if hard_delete:
            _purge_client_local_data(db, local_user, target_email)
        elif local_user:
            # Mark the local row inactive so they disappear from pickers, and so
            # `get_current_user` rejects their still-valid JWT on the next request.
            local_user.is_active = False
            db.commit()
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


# ── Client invites (Flow A: personal setup-link email) ───────────────
# See app/client_invites.py for Flow B (admin generates a copy/paste
# link and sends it themselves via text or email).


class InviteClientRequest(BaseModel):
    email: EmailStr
    name: str = ""
    # Must exactly match an existing sites/pipelines `client` value — the
    # frontend populates this from the same dropdown as the map's client
    # filter, so there's no free-typed spelling drift.
    client_name: str
    # Optional. Empty/omitted = the client can see every area for
    # client_name. Non-empty restricts them to just those areas (e.g. a
    # CNRL contact who only covers one field office).
    client_areas: Optional[list[str]] = None


@router.post(
    "/invite-client",
    response_model=SimpleMessageResponse,
    dependencies=[Depends(require_roles(*MANAGES_PINS))],
)
async def invite_client(
    payload: InviteClientRequest,
    db: Session = Depends(get_db),
) -> SimpleMessageResponse:
    """Create a read-only client-portal account and email them a one-tap
    "set your password" link (Flow A).

    The account is created with `role: "client"` and the given
    `client_name`/`client_areas` in `app_metadata` — never `user_metadata`,
    so the client can't edit their own scope. The password is a random
    value nobody is ever told; the recipient sets their own via the
    setup-link email (same mechanism as `send_user_password_reset`).
    """
    client_name = payload.client_name.strip()
    if not client_name:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="client_name is required")
    client_areas = [a.strip() for a in (payload.client_areas or []) if isinstance(a, str) and a.strip()] or None

    if db is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Client invites are not available — backend has no database session.",
        )
    if not email_transport_configured():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                "Email is not configured on the server. Set RESEND_API_KEY + "
                "RESEND_FROM_EMAIL (recommended on Render) or SMTP_USER + "
                "SMTP_PASSWORD, then redeploy."
            ),
        )

    display_name = payload.name.strip() or payload.email.split("@")[0].title()
    client = get_supabase_admin()

    # `app_metadata` is sent as a plain dict over the wire (JSON), so an
    # explicit `None` here becomes a JSON `null` value under `client_areas`
    # rather than the key being absent. Both are harmless to read back
    # (get_current_user/_format_user already handle either), but omitting
    # the key entirely is the more conservative choice for any Postgres-side
    # trigger/function on this project that might not expect an explicit
    # null in a JSONB column it isn't defensively coded against.
    app_metadata: dict = {
        "role": RoleEnum.client.value,
        "name": display_name,
        "client_name": client_name,
    }
    if client_areas:
        app_metadata["client_areas"] = client_areas

    try:
        result = client.auth.admin.create_user(
            {
                "email": payload.email,
                "password": secrets.token_urlsafe(32),  # nobody is ever told this
                "email_confirm": True,
                "app_metadata": app_metadata,
                "user_metadata": {"name": display_name},
            }
        )
    except Exception as exc:
        error_msg = str(exc)
        error_code = getattr(exc, "code", None)
        error_status = getattr(exc, "status", None)
        if "already been registered" in error_msg.lower() or "already exists" in error_msg.lower():
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="A user with this email already exists",
            )
        logger.exception(
            "Error creating client user %s: %s (code=%s status=%s)",
            mask_email(payload.email),
            type(exc).__name__,
            error_code,
            error_status,
        )
        # "Database error creating new user" is GoTrue's generic wrapper for
        # a Postgres-level failure during the auth.users/auth.identities
        # insert — most commonly a leftover row (soft-deleted or otherwise
        # incomplete) still occupying this email, or a custom trigger on
        # auth.users rejecting the row. Neither is fixable by retrying with
        # the same email, so say so explicitly instead of just "try again".
        hint = ""
        if "database error" in error_msg.lower():
            hint = (
                " This usually means a leftover or soft-deleted Supabase Auth user already "
                "occupies this email — check the Supabase dashboard (Authentication > Users, "
                "including any 'deleted' filter) for an existing row with this address, or ask "
                "your developer to check Postgres Logs in the Supabase dashboard for the exact "
                "underlying error."
            )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to create client account ({type(exc).__name__}): {error_msg}{hint}",
        )

    user_id = result.user.id

    try:
        reset_code = PasswordResetCode(email=payload.email, expires_at=datetime.utcnow() + timedelta(hours=24))
        db.add(reset_code)
        db.commit()
        db.refresh(reset_code)
    except Exception as exc:
        db.rollback()
        logger.exception("DB error issuing client setup link for %s: %s", mask_email(payload.email), type(exc).__name__)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=(
                f"Account created but could not issue setup link ({type(exc).__name__}: {exc}). "
                "The client account already exists in Supabase — use 'Send password reset' from "
                "the user list below to retry sending them a link."
            ),
        )

    setup_url = f"{settings.frontend_url.rstrip('/')}/?setup_token={reset_code.reset_token}"

    try:
        await send_password_setup_link(payload.email, setup_url, display_name)
    except Exception as exc:
        logger.exception("Email error sending client setup link to %s: %s", mask_email(payload.email), type(exc).__name__)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Account created but the email failed to send. Use 'Send password reset' from the user list to retry.",
        )

    logger.info("Client account created + setup link sent to %s (client=%s)", mask_email(payload.email), client_name)
    return SimpleMessageResponse(
        message=f"Client account created. A one-tap setup link was emailed to {payload.email}.",
    )
