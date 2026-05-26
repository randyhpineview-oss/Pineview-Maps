from collections.abc import Callable
from typing import Optional
import hashlib

import jwt
from fastapi import Depends, HTTPException, Request, status
from jwt import PyJWKClient
from sqlalchemy.orm import Session

from app.config import get_settings
from app.database import get_db
from app.log_util import get_logger, mask_email, short_id
from app.models import RoleEnum, User

settings = get_settings()
logger = get_logger(__name__)

# Lazy-initialized JWKS client. Built on first request so a transient
# network hiccup at container start doesn't crash the service — the
# first authenticated request will pay the fetch cost (~100 ms), and
# every request thereafter uses the in-memory cache (300s lifespan).
_jwks_client: Optional[PyJWKClient] = None


def _get_jwks_client() -> PyJWKClient:
    global _jwks_client
    if _jwks_client is None:
        jwks_url = settings.supabase_jwt_jwks_url or (
            f"{settings.supabase_url.rstrip('/')}/auth/v1/.well-known/jwks.json"
        )
        # ``cache_keys=True`` + ``lifespan=300`` means PyJWT re-fetches
        # at most every 5 minutes, which handles Supabase's transparent
        # key rotations (standby → current) without any ops work.
        _jwks_client = PyJWKClient(jwks_url, cache_keys=True, lifespan=300)
    return _jwks_client


def _stable_user_id(sub: str) -> int:
    """Deterministic 31-bit positive int derived from the Supabase ``sub`` UUID.

    Replaces Python's built-in ``hash()``, which is salted per-process in
    CPython 3.3+ and therefore produced DIFFERENT ids for the same UUID
    across gunicorn workers / container restarts. The previous code then
    leaned on a ``% 1_000_000`` modulus that added ~0.02% collision risk
    for even a handful of users.

    SHA-256 is deterministic across processes and machines. We take the
    first 8 hex chars and mask off the sign bit so the result always
    fits in a signed 32-bit Postgres ``INTEGER`` (max 2,147,483,647).
    Without the mask, ~50% of UUIDs hashed to a value ≥ 2³¹ and the
    INSERT/SELECT cast on ``users.id`` raised ``NumericValueOutOfRange``.
    Collision risk at 31 bits for 20 users: ~9×10⁻⁸. No DB migration
    needed — existing rows still resolve via ``_upsert_supabase_user``'s
    email fallback.
    """
    digest = hashlib.sha256(sub.encode("utf-8")).hexdigest()
    return int(digest[:8], 16) & 0x7FFFFFFF


# Roles allowed to create/approve/edit map pins (sites & pipelines), import
# standalone lease sheets onto pins, and view the Check-ins Dashboard. The
# crew_lead role sits above worker (its own forms only) but below
# office/admin (full data-administration access).
MANAGES_PINS: tuple[RoleEnum, ...] = (RoleEnum.admin, RoleEnum.office, RoleEnum.crew_lead)


DEMO_USERS = {
    "admin": {"name": "Pineview Admin", "email": "admin@pineview.local", "role": RoleEnum.admin},
    "office": {"name": "Pineview Office", "email": "office@pineview.local", "role": RoleEnum.office},
    "crew_lead": {"name": "Pineview Crew Lead", "email": "crewlead@pineview.local", "role": RoleEnum.crew_lead},
    "worker": {"name": "Pineview Worker", "email": "worker@pineview.local", "role": RoleEnum.worker},
}


def seed_demo_users(db: Session) -> None:
    for user_data in DEMO_USERS.values():
        existing = db.query(User).filter(User.email == user_data["email"]).first()
        if existing:
            continue
        db.add(User(**user_data))
    db.commit()


def _upsert_supabase_user(
    db: Session,
    actual_id: int,
    email: str,
    name: str,
    role: RoleEnum,
) -> User:
    """Ensure a User row exists in the local `users` table for a Supabase-authenticated
    caller so FK-backed columns (e.g. `created_by_user_id`) can reference it.

    Supabase users are synthesized from the JWT; without this, every `created_by_user_id`
    would be NULL, breaking role-scoped visibility (e.g. workers can't see their own
    T&M tickets).

    Behavior:
      - Look up by id first (stable hash of the Supabase `sub` claim).
      - If not found, look up by email (handles case where a different hash previously
        claimed this email, or a demo-seeded row exists with this email).
      - Insert if neither exists. Update name/role if they changed.

    Never raises — auth should continue to work even if the users table is read-only
    (we fall back to a transient User object in that case).
    """
    try:
        existing = db.query(User).filter(User.id == actual_id).first()
        if existing is None:
            existing = db.query(User).filter(User.email == email).first()

        if existing is None:
            new_user = User(id=actual_id, email=email, name=name, role=role)
            db.add(new_user)
            db.commit()
            db.refresh(new_user)
            return new_user

        # Keep the row in sync with whatever the JWT says.
        changed = False
        if existing.name != name:
            existing.name = name
            changed = True
        if existing.role != role:
            existing.role = role
            changed = True
        if changed:
            db.commit()
            db.refresh(existing)
        return existing
    except Exception as exc:
        # Surface enough info for debugging without blocking auth or
        # leaking raw emails into logs.
        logger.warning(
            "Could not upsert Supabase user (email=%s id=%s): %s",
            mask_email(email),
            short_id(actual_id),
            type(exc).__name__,
        )
        try:
            db.rollback()
        except Exception:
            pass
        # Fall back to a transient object — callers that need a persisted row will fail
        # their FK writes, but auth itself still succeeds.
        return User(id=actual_id, email=email, name=name, role=role)


def get_current_user(request: Request, db: Session = Depends(get_db)) -> User:
    # Supabase mode: verify JWT signature + claims before trusting anything
    # the token says. The previous implementation base64-decoded the payload
    # without verifying the signature at all, which meant a malicious client
    # could mint a token claiming ``role: admin`` and the backend would
    # accept it. We now verify the ES256 signature against Supabase's
    # public JWKS before reading any claim.
    if settings.use_supabase:
        authorization: Optional[str] = request.headers.get("Authorization")
        if not authorization or not authorization.startswith("Bearer "):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Missing authentication token",
            )
        token = authorization.split(" ", 1)[1].strip()
        if not token:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Missing authentication token",
            )

        try:
            jwks_client = _get_jwks_client()
            signing_key = jwks_client.get_signing_key_from_jwt(token)
            payload = jwt.decode(
                token,
                signing_key.key,
                algorithms=["ES256"],
                audience="authenticated",
                leeway=10,  # tolerate small client/server clock skew
            )
        except jwt.ExpiredSignatureError:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Token expired",
            )
        except jwt.InvalidTokenError as exc:
            logger.info("Auth rejected: %s", type(exc).__name__)
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid authentication token",
            )
        except Exception as exc:
            # Typically a PyJWKClientError from a JWKS fetch/network issue.
            # Fail closed: reject rather than silently downgrading.
            logger.warning("JWKS verification error: %s", type(exc).__name__)
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid authentication token",
            )

        user_email = payload.get("email")
        if not user_email:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Token missing email claim",
            )

        sub = payload.get("sub")
        if not sub:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Token missing sub claim",
            )

        user_metadata = payload.get("user_metadata") or {}
        role_str = user_metadata.get("role", "worker")
        user_name = user_metadata.get("name") or user_email.split("@")[0].title()
        try:
            role_enum = RoleEnum(role_str)
        except ValueError:
            role_enum = RoleEnum.worker

        # Deterministic integer id derived from the Supabase UUID so the
        # same user maps to the same local row across gunicorn workers
        # and container restarts. Numeric sub (demo/test) pass through.
        actual_id = int(sub) if sub.isdigit() else _stable_user_id(sub)

        # Ensure a matching row exists in the local `users` table so
        # FK-backed columns (e.g. created_by_user_id on T&M tickets)
        # can reference this caller. Without this, workers lose
        # visibility of their own tickets.
        if db is not None:
            user = _upsert_supabase_user(
                db,
                actual_id=actual_id,
                email=user_email,
                name=user_name,
                role=role_enum,
            )
        else:
            user = User(
                id=actual_id,
                email=user_email,
                name=user_name,
                role=role_enum,
            )
        return user
    
    # Development mode: use demo users with SQLite
    if db is None:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Database not available")
    
    requested_role = request.headers.get("X-Demo-User", "worker").lower().strip()
    if requested_role not in DEMO_USERS:
        requested_role = "worker"

    user = db.query(User).filter(User.email == DEMO_USERS[requested_role]["email"]).first()
    if user is None:
        seed_demo_users(db)
        user = db.query(User).filter(User.email == DEMO_USERS[requested_role]["email"]).first()
    if user is None:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Demo user setup failed")
    return user


def require_roles(*roles: RoleEnum) -> Callable:
    def dependency(user: User = Depends(get_current_user)) -> User:
        if user.role not in roles:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You do not have access to this action")
        return user

    return dependency