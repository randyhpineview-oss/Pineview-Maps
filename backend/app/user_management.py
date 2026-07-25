"""User management endpoints using Supabase Admin API.

These endpoints allow admins to create, list, update, and delete
Supabase Auth users directly from the Pineview Maps admin panel.
"""

from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, EmailStr
from sqlalchemy import text
from sqlalchemy.orm import Session
from supabase import create_client

import secrets

from app.auth import MANAGES_PINS, get_current_user, is_dev_email, require_roles, _stable_user_id
from app.client_scope import (
    build_scope_app_metadata,
    clean_client_access,
    display_client_names,
    legacy_fields_from_access,
    parse_scope_payload,
    resolve_client_access,
)
from app.config import get_settings
from app.database import engine, get_db
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


def _normalize_email(email: Optional[str]) -> str:
    return (email or "").strip().lower()


def _auth_users_from_list_result(result) -> list:
    if result is None:
        return []
    if isinstance(result, list):
        return result
    users = getattr(result, "users", None)
    if users is not None:
        return list(users)
    if isinstance(result, dict):
        return list(result.get("users") or [])
    return []


def _list_all_auth_users(client) -> list:
    """Paginate Supabase Admin list_users (default page is too small for a full roster)."""
    users: list = []
    page = 1
    per_page = 200
    while page <= 50:
        try:
            result = client.auth.admin.list_users(page=page, per_page=per_page)
        except TypeError:
            # Older supabase-py: list_users() takes no kwargs.
            result = client.auth.admin.list_users()
            return _auth_users_from_list_result(result)
        batch = _auth_users_from_list_result(result)
        if not batch:
            break
        users.extend(batch)
        if len(batch) < per_page:
            break
        page += 1
    return users


def _auth_role(user) -> str:
    app_metadata = getattr(user, "app_metadata", None) or {}
    user_metadata = getattr(user, "user_metadata", None) or {}
    if isinstance(app_metadata, dict) and app_metadata.get("role"):
        return str(app_metadata.get("role"))
    if isinstance(user_metadata, dict) and user_metadata.get("role"):
        return str(user_metadata.get("role"))
    return "worker"


def _prefer_auth_user(users: list):
    """Among Auth rows sharing an email, keep the real account (confirmed / logged-in)."""

    def score(u) -> tuple:
        confirmed = 1 if getattr(u, "email_confirmed_at", None) else 0
        signed_in = 1 if getattr(u, "last_sign_in_at", None) else 0
        last = str(getattr(u, "last_sign_in_at", None) or "")
        created = str(getattr(u, "created_at", None) or "")
        return (confirmed, signed_in, last, created)

    return max(users, key=score)


def _find_auth_users_by_email(client, email: str) -> list:
    needle = _normalize_email(email)
    if not needle:
        return []
    return [
        u
        for u in _list_all_auth_users(client)
        if _normalize_email(getattr(u, "email", None)) == needle
        and not getattr(u, "deleted_at", None)
    ]


def _dedupe_auth_users_by_email(users: list) -> list:
    by_email: dict[str, list] = {}
    order: list[str] = []
    for u in users:
        if getattr(u, "deleted_at", None):
            continue
        key = _normalize_email(getattr(u, "email", None)) or f"id:{getattr(u, 'id', '')}"
        if key not in by_email:
            by_email[key] = [u]
            order.append(key)
        else:
            by_email[key].append(u)
    out = []
    for key in order:
        group = by_email[key]
        out.append(_prefer_auth_user(group) if len(group) > 1 else group[0])
    return out


def _postgres_auth_schema_available(db: Optional[Session]) -> bool:
    """True when we can query Supabase ``auth.users`` / ``auth.identities`` via SQL."""
    if db is None or engine is None:
        return False
    try:
        return engine.dialect.name == "postgresql"
    except Exception:
        return False


def _hard_delete_auth_user(client, user_id: str) -> None:
    """Hard-delete an Auth user; raise if the SDK returns an error object."""
    result = client.auth.admin.delete_user(str(user_id), should_soft_delete=False)
    err = getattr(result, "error", None)
    if err is None and isinstance(result, dict):
        err = result.get("error")
    if err is not None:
        raise RuntimeError(str(err))


def _find_auth_user_ids_holding_email(db: Session, email: str) -> list[str]:
    """Return Auth user ids still claiming this email (including soft-deleted ghosts).

    Soft-delete obfuscates ``auth.users.email`` (so the dashboard search is empty)
    but often leaves ``auth.identities.email`` intact — that's what blocks
    ``create_user`` with "Database error creating new user".
    """
    if not _postgres_auth_schema_available(db):
        return []
    email_l = _normalize_email(email)
    if not email_l:
        return []
    try:
        rows = db.execute(
            text(
                """
                SELECT DISTINCT user_id::text AS uid
                FROM auth.identities
                WHERE lower(email) = :email
                   OR lower(coalesce(identity_data->>'email', '')) = :email
                UNION
                SELECT id::text AS uid
                FROM auth.users
                WHERE lower(email) = :email
                """
            ),
            {"email": email_l},
        ).fetchall()
        return [r[0] for r in rows if r and r[0]]
    except Exception as exc:
        logger.warning(
            "Could not scan auth.identities/users for %s: %s",
            mask_email(email),
            type(exc).__name__,
        )
        try:
            db.rollback()
        except Exception:
            pass
        return []


def _purge_auth_email_residue(db: Optional[Session], email: Optional[str]) -> list[str]:
    """Hard-delete every Auth user still holding this email (identity or users row).

    Used after client delete and as a create_user recovery path so an email that
    looks "gone" in the Supabase Users UI can still be re-invited.
    """
    if db is None or not email:
        return []
    ids = _find_auth_user_ids_holding_email(db, email)
    if not ids:
        return []
    client = get_supabase_admin()
    purged: list[str] = []
    for uid in ids:
        try:
            _hard_delete_auth_user(client, uid)
            purged.append(uid)
            logger.info(
                "Purged Auth residue user %s still holding %s",
                short_id(uid),
                mask_email(email),
            )
        except Exception:
            # Last resort: SQL hard-delete (CASCADE clears identities/sessions).
            try:
                db.execute(text("DELETE FROM auth.users WHERE id = CAST(:id AS uuid)"), {"id": uid})
                db.commit()
                purged.append(uid)
                logger.info(
                    "SQL hard-deleted Auth residue user %s for %s",
                    short_id(uid),
                    mask_email(email),
                )
            except Exception:
                try:
                    db.rollback()
                except Exception:
                    pass
                logger.exception(
                    "Failed to purge Auth residue user %s for %s",
                    short_id(uid),
                    mask_email(email),
                )
    # Belt-and-suspenders: clear any leftover identity rows by email even if
    # the parent user row is already gone.
    if _postgres_auth_schema_available(db):
        try:
            db.execute(
                text(
                    """
                    DELETE FROM auth.identities
                    WHERE lower(email) = :email
                       OR lower(coalesce(identity_data->>'email', '')) = :email
                    """
                ),
                {"email": _normalize_email(email)},
            )
            db.commit()
        except Exception:
            try:
                db.rollback()
            except Exception:
                pass
    return purged


def _purge_duplicate_client_auth_users(client, keep_user_id: str, email: Optional[str]) -> int:
    """Hard-delete extra Auth rows for the same email (duplicate client shells).

    Keeps ``keep_user_id``. Deletes other ``role=client`` accounts and any
    never-confirmed / never-signed-in shell sharing the email. Never deletes
    a confirmed staff account (admin/office/crew_lead/worker/tv).
    """
    matches = _find_auth_users_by_email(client, email or "")
    purged = 0
    for u in matches:
        uid = getattr(u, "id", None)
        if not uid or str(uid) == str(keep_user_id):
            continue
        role = _auth_role(u)
        confirmed = getattr(u, "email_confirmed_at", None)
        last_login = getattr(u, "last_sign_in_at", None)
        is_client = role == RoleEnum.client.value
        is_unused_shell = (not confirmed) and (not last_login)
        # Confirmed in-house roles must never be deleted via this helper.
        staff_roles = {
            RoleEnum.admin.value,
            RoleEnum.office.value,
            RoleEnum.crew_lead.value,
            RoleEnum.worker.value,
            RoleEnum.tv.value,
        }
        if role in staff_roles and confirmed:
            continue
        if not (is_client or is_unused_shell):
            continue
        try:
            _hard_delete_auth_user(client, str(uid))
            purged += 1
            logger.info(
                "Purged duplicate Auth user %s for %s (kept %s, role=%s)",
                short_id(uid),
                mask_email(email),
                short_id(keep_user_id),
                role,
            )
        except Exception:
            logger.exception(
                "Failed to purge duplicate Auth user %s for %s",
                short_id(uid),
                mask_email(email),
            )
    return purged


# ── Request / Response schemas ──────────────────────────────────────


class UserCreate(BaseModel):
    email: str
    password: str
    role: RoleEnum = RoleEnum.worker
    name: str = ""


class ClientAccessEntryIn(BaseModel):
    client: str
    areas: Optional[list[str]] = None


class UserUpdate(BaseModel):
    role: Optional[RoleEnum] = None
    name: Optional[str] = None
    # Only meaningful for existing role=="client" accounts — lets an admin
    # re-scope an already-created client without recreating the account.
    # Rejected (400) if the target user isn't currently a client — use
    # invite-client to create one.
    # Prefer `client_access` (multi-company). Legacy single-company fields
    # still accepted and converted.
    client_access: Optional[list[ClientAccessEntryIn]] = None
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
    # Only meaningful when role == "client". Prefer client_access.
    client_name: Optional[str] = None
    client_areas: Optional[list[str]] = None
    client_access: Optional[list[dict]] = None


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
    access = resolve_client_access(
        client_access=app_metadata.get("client_access"),
        client_name=app_metadata.get("client_name"),
        client_areas=app_metadata.get("client_areas"),
    ) or None
    mirror_name, mirror_areas = legacy_fields_from_access(access)
    return UserResponse(
        id=user.id,
        email=user.email or "",
        role=role,
        name=name,
        created_at=str(user.created_at) if user.created_at else "",
        last_sign_in_at=str(user.last_sign_in_at) if user.last_sign_in_at else None,
        email_confirmed_at=str(user.email_confirmed_at) if getattr(user, "email_confirmed_at", None) else None,
        deleted_at=str(user.deleted_at) if getattr(user, "deleted_at", None) else None,
        client_name=mirror_name or app_metadata.get("client_name"),
        client_areas=mirror_areas if access else (app_metadata.get("client_areas") or None),
        client_access=access,
    )


# ── Endpoints ───────────────────────────────────────────────────────


@router.get(
    "",
    response_model=list[UserResponse],
    dependencies=[Depends(require_roles(RoleEnum.admin))],
)
def list_users(current_user: User = Depends(get_current_user)) -> list[UserResponse]:
    """List all Supabase Auth users (excluding soft-deleted).

    Collapses duplicate Auth rows that share an email (common leftover from
    re-inviting a client) so User Management shows one card per person.
    Extra ``client`` duplicates are hard-deleted in the background — the
    confirmed / last-login account is kept.
    """
    client = get_supabase_admin()
    try:
        users = _list_all_auth_users(client)
        active_users = [u for u in users if not getattr(u, "deleted_at", None)]
        if not is_dev_email(getattr(current_user, "email", None)):
            active_users = [
                u for u in active_users if not is_dev_email(getattr(u, "email", None))
            ]

        # Purge extra Auth rows for the same email, then rebuild the response
        # from survivors only (never trust in-memory rows after a delete).
        by_email: dict[str, list] = {}
        for u in active_users:
            key = _normalize_email(getattr(u, "email", None))
            if not key:
                continue
            by_email.setdefault(key, []).append(u)
        for email_key, group in by_email.items():
            if len(group) < 2:
                continue
            if not any(_auth_role(u) == RoleEnum.client.value for u in group):
                continue
            keep = _prefer_auth_user(group)
            _purge_duplicate_client_auth_users(client, str(keep.id), email_key)

        # Re-list after purge so a failed-delete doesn't leave ghosts, and so
        # soft-deleted leftovers (deleted_at set) drop out of the response.
        refreshed = [
            u
            for u in _list_all_auth_users(client)
            if not getattr(u, "deleted_at", None)
        ]
        if not is_dev_email(getattr(current_user, "email", None)):
            refreshed = [
                u for u in refreshed if not is_dev_email(getattr(u, "email", None))
            ]
        deduped = _dedupe_auth_users_by_email(refreshed)
        return [_format_user(u) for u in deduped]
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
    client_access: Optional[list[dict]],
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
        access = clean_client_access(client_access)
        name, areas = legacy_fields_from_access(access)
        local_user = _find_local_user(db, user_id, email)
        if local_user is None:
            # Invite / first-edit before the client has logged in — seed the
            # local row so get_current_user has DB-authoritative scope on
            # their very first request (not only after JWT upsert).
            if not email:
                return
            local_user = User(
                id=_stable_user_id(user_id),
                email=email,
                name=email.split("@")[0].title(),
                role=RoleEnum.client,
                is_active=True,
                client_access=access,
                client_name=name,
                client_areas=areas,
            )
            db.add(local_user)
            db.commit()
            return
        local_user.client_access = access
        local_user.client_name = name
        local_user.client_areas = areas
        if local_user.role != RoleEnum.client:
            local_user.role = RoleEnum.client
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
    client scope from app_metadata, but that's harmless: `app/auth.py`
    only reads those fields when `role == client`.

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

        # Clients are invite-only external accounts — never promote/demote
        # them into in-house roles via this endpoint.
        if (
            payload.role is not None
            and existing_app_metadata.get("role") == RoleEnum.client.value
        ):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Client accounts can't be changed to an in-house role. Delete the client "
                "and create a staff user separately if needed.",
            )

        scope_touch = (
            payload.client_access is not None
            or payload.client_name is not None
            or payload.client_areas is not None
        )
        if scope_touch and existing_app_metadata.get("role") != RoleEnum.client.value:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="client_access can only be set on an existing client account.",
            )

        if payload.role is not None:
            existing_app_metadata["role"] = payload.role.value
        if payload.name is not None:
            existing_app_metadata["name"] = payload.name

        new_access: Optional[list[dict]] = None
        if scope_touch:
            try:
                # Prefer structured client_access when provided. Legacy fields
                # alone still work for single-company edits from older UIs.
                if payload.client_access is not None:
                    new_access = parse_scope_payload(
                        client_access=[e.model_dump() for e in payload.client_access],
                    )
                else:
                    # Partial legacy update: start from existing scope, then
                    # overlay name and/or areas.
                    current_access = resolve_client_access(
                        client_access=existing_app_metadata.get("client_access"),
                        client_name=existing_app_metadata.get("client_name"),
                        client_areas=existing_app_metadata.get("client_areas"),
                    )
                    if payload.client_name is not None:
                        new_access = parse_scope_payload(
                            client_name=payload.client_name,
                            client_areas=(
                                payload.client_areas
                                if payload.client_areas is not None
                                else (current_access[0]["areas"] if len(current_access) == 1 else None)
                            ),
                        )
                    else:
                        # areas-only update on a single-company account
                        if len(current_access) != 1:
                            raise ValueError(
                                "Send client_access when editing a multi-company account."
                            )
                        new_access = parse_scope_payload(
                            client_name=current_access[0]["client"],
                            client_areas=payload.client_areas,
                        )
            except ValueError as exc:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))

            # Replace scope keys cleanly (drop stale areas when unrestricted).
            existing_app_metadata.pop("client_access", None)
            existing_app_metadata.pop("client_name", None)
            existing_app_metadata.pop("client_areas", None)
            existing_app_metadata.update(build_scope_app_metadata(new_access))

        if (
            payload.role is None
            and payload.name is None
            and not scope_touch
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

        target_email = getattr(current_user_obj, "email", None)
        target_role = existing_app_metadata.get("role")
        # Any edit to a client (name, access, …) must keep a single Auth row
        # for that email — editing the name was previously recreating the
        # "Unconfirmed" duplicate card in User Management.
        if target_role == RoleEnum.client.value:
            _purge_duplicate_client_auth_users(client, user_id, target_email)
            if scope_touch:
                _mirror_client_scope_locally(
                    db,
                    user_id=user_id,
                    email=target_email,
                    client_access=new_access,
                )
            elif payload.name is not None and db is not None:
                # Keep local display name in sync without inventing scope.
                local_user = _find_local_user(db, user_id, target_email)
                if local_user is not None and local_user.name != payload.name:
                    local_user.name = payload.name
                    db.commit()

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

        local_user = _find_local_user(db, user_id, target_email)
        local_is_client = (
            local_user is not None
            and getattr(local_user, "role", None) == RoleEnum.client
        )

        # Hard-delete clients so the email is freed for re-invite. Soft-delete
        # leaves an obfuscated auth.users row + an auth.identities.email that
        # still blocks create_user — invisible in the Users dashboard search.
        # Fall back to the local role when Auth metadata lookup failed.
        hard_delete = (
            (target_role == RoleEnum.client.value or local_is_client)
            and not is_dev_email(target_email)
        )

        if hard_delete:
            _hard_delete_auth_user(client, user_id)
            # Wipe identity residue that soft-delete historically left behind
            # (and any sibling Auth rows for the same email).
            _purge_auth_email_residue(db, target_email)
            _purge_client_local_data(db, local_user, target_email)
        else:
            client.auth.admin.delete_user(user_id, should_soft_delete=True)
            if local_user:
                # Mark the local row inactive so they disappear from pickers, and so
                # `get_current_user` rejects their still-valid JWT on the next request.
                local_user.is_active = False
                db.commit()
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception(
            "Error deleting user %s: %s", short_id(user_id), type(exc).__name__
        )
        error_detail = str(exc)
        if "Database error" in error_detail or "storage" in error_detail.lower():
            error_detail = (
                "Cannot delete user — Supabase still has related data (often Storage "
                "objects owned by this Auth user, or a leftover auth.identities row). "
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
    # Preferred: one or more companies, each with optional area allowlist.
    # Client names must exactly match existing sites/pipelines `client`
    # values — the frontend populates them from the map's client list.
    client_access: Optional[list[ClientAccessEntryIn]] = None
    # Legacy single-company fields (still accepted).
    client_name: Optional[str] = None
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
    """Create OR update a read-only client-portal account and email a setup link.

    If this email already has a client account, scope is updated in place
    (same as Edit access) — we never create a second Unconfirmed card for
    the same person. Non-client accounts with the email still conflict.
    """
    try:
        access = parse_scope_payload(
            client_access=[e.model_dump() for e in payload.client_access] if payload.client_access else None,
            client_name=payload.client_name,
            client_areas=payload.client_areas,
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))

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

    app_metadata: dict = {
        "role": RoleEnum.client.value,
        "name": display_name,
        **build_scope_app_metadata(access),
    }

    existing_matches = _find_auth_users_by_email(client, payload.email)
    updated_existing = False
    user_id: str

    if existing_matches:
        keep = _prefer_auth_user(existing_matches)
        existing_role = _auth_role(keep)
        if existing_role != RoleEnum.client.value:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=(
                    "A non-client user with this email already exists. "
                    "Delete or rename that account before inviting them as a client."
                ),
            )
        user_id = str(keep.id)
        # Preserve an admin-set display name if the invite form left name blank.
        if not payload.name.strip():
            existing_meta = getattr(keep, "app_metadata", None) or {}
            existing_name = existing_meta.get("name") if isinstance(existing_meta, dict) else None
            if existing_name:
                display_name = existing_name
                app_metadata["name"] = display_name
        try:
            client.auth.admin.update_user_by_id(
                user_id,
                {
                    "email_confirm": True,
                    "app_metadata": app_metadata,
                    "user_metadata": {"name": display_name},
                },
            )
        except Exception as exc:
            logger.exception(
                "Error updating existing client %s: %s",
                mask_email(payload.email),
                type(exc).__name__,
            )
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Failed to update existing client account ({type(exc).__name__}): {exc}",
            )
        _purge_duplicate_client_auth_users(client, user_id, payload.email)
        updated_existing = True
    else:
        create_payload = {
            "email": payload.email,
            "password": secrets.token_urlsafe(32),  # nobody is ever told this
            "email_confirm": True,
            "app_metadata": app_metadata,
            "user_metadata": {"name": display_name},
        }
        try:
            result = client.auth.admin.create_user(create_payload)
        except Exception as exc:
            error_msg = str(exc)
            error_l = error_msg.lower()
            # Soft-deleted / identity-ghost residue: email looks free in the
            # Users UI but create_user still hits a unique constraint. Purge
            # auth.identities (+ users) holding this email and retry once.
            if (
                "database error" in error_l
                or "already been registered" in error_l
                or "already exists" in error_l
                or "duplicate" in error_l
            ):
                purged = _purge_auth_email_residue(db, payload.email)
                if purged:
                    logger.info(
                        "Cleared %d Auth residue row(s) for %s; retrying create_user",
                        len(purged),
                        mask_email(payload.email),
                    )
                    try:
                        result = client.auth.admin.create_user(create_payload)
                    except Exception as retry_exc:
                        logger.exception(
                            "Retry create_user failed for %s: %s",
                            mask_email(payload.email),
                            type(retry_exc).__name__,
                        )
                        raise HTTPException(
                            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                            detail=(
                                f"Failed to create client account after clearing leftover Auth "
                                f"data ({type(retry_exc).__name__}): {retry_exc}"
                            ),
                        ) from retry_exc
                elif "already been registered" in error_l or "already exists" in error_l:
                    raise HTTPException(
                        status_code=status.HTTP_409_CONFLICT,
                        detail="A user with this email already exists",
                    ) from exc
                else:
                    logger.exception(
                        "Error creating client user %s: %s",
                        mask_email(payload.email),
                        type(exc).__name__,
                    )
                    raise HTTPException(
                        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                        detail=(
                            f"Failed to create client account ({type(exc).__name__}): {error_msg}. "
                            "A leftover soft-deleted Auth identity may still hold this email — "
                            "try Invite again after deploy, or run in Supabase SQL: "
                            "SELECT * FROM auth.identities WHERE lower(email) = lower('...');"
                        ),
                    ) from exc
            else:
                logger.exception(
                    "Error creating client user %s: %s (code=%s status=%s)",
                    mask_email(payload.email),
                    type(exc).__name__,
                    getattr(exc, "code", None),
                    getattr(exc, "status", None),
                )
                raise HTTPException(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    detail=f"Failed to create client account ({type(exc).__name__}): {error_msg}",
                ) from exc
        user_id = result.user.id

    _mirror_client_scope_locally(
        db,
        user_id=user_id,
        email=payload.email,
        client_access=access,
    )

    try:
        existing_codes = (
            db.query(PasswordResetCode)
            .filter(
                PasswordResetCode.email == payload.email,
                PasswordResetCode.is_used == False,  # noqa: E712
            )
            .all()
        )
        for code in existing_codes:
            code.is_used = True
        reset_code = PasswordResetCode(
            email=payload.email,
            expires_at=datetime.utcnow() + timedelta(hours=24),
        )
        db.add(reset_code)
        db.commit()
        db.refresh(reset_code)
    except Exception as exc:
        db.rollback()
        logger.exception(
            "DB error issuing client setup link for %s: %s",
            mask_email(payload.email),
            type(exc).__name__,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=(
                f"Account {'updated' if updated_existing else 'created'} but could not issue "
                f"setup link ({type(exc).__name__}: {exc}). Use 'Send setup link' from the "
                "user list to retry."
            ),
        )

    setup_url = f"{settings.frontend_url.rstrip('/')}/?setup_token={reset_code.reset_token}"

    try:
        await send_password_setup_link(payload.email, setup_url, display_name)
    except Exception as exc:
        logger.exception(
            "Email error sending client setup link to %s: %s",
            mask_email(payload.email),
            type(exc).__name__,
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=(
                f"Account {'updated' if updated_existing else 'created'} but the email failed "
                "to send. Use 'Send setup link' from the user list to retry."
            ),
        )

    companies = display_client_names(access)
    logger.info(
        "Client account %s + setup link sent to %s (clients=%s)",
        "updated" if updated_existing else "created",
        mask_email(payload.email),
        companies,
    )
    if updated_existing:
        return SimpleMessageResponse(
            message=(
                f"Updated existing client access for {payload.email} "
                f"({companies}) and emailed a setup link. No new account was created."
            ),
        )
    return SimpleMessageResponse(
        message=f"Client account created. A one-tap setup link was emailed to {payload.email}.",
    )
