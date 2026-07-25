"""One-shot / idempotent upgrade: legacy client_name+client_areas → client_access.

Safe to re-run. Only touches local `users` rows where:
  - role = client
  - client_access is NULL/empty
  - client_name is set

Also ensures the `users.client_access` / `client_invites.client_access`
columns exist (ADD COLUMN IF NOT EXISTS) before any ORM query — useful if
running manually against a DB that has not yet booted the fixed API.

Does NOT rewrite Supabase app_metadata (that happens on the next admin
Edit access, or is synthesized from legacy fields by auth.resolve on read).
Run from the backend directory:

    python -m scripts.migrate_client_access

Or with DATABASE_URL pointed at production.
"""

from __future__ import annotations

import sys
from pathlib import Path

# Allow `python scripts/migrate_client_access.py` from repo root or backend/.
BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from sqlalchemy import text  # noqa: E402

from app.client_scope import client_access_from_legacy, legacy_fields_from_access  # noqa: E402
from app.database import Base, SessionLocal, engine  # noqa: E402
from app.models import ClientInvite, RoleEnum, User  # noqa: E402


def _ensure_columns() -> None:
    if engine is None:
        raise RuntimeError("DATABASE_URL / engine is not configured")
    is_sqlite = str(engine.url).startswith("sqlite")
    col_type = "JSON" if is_sqlite else "JSONB"
    Base.metadata.create_all(bind=engine, tables=[ClientInvite.__table__], checkfirst=True)
    with engine.begin() as conn:
        conn.execute(text(f"ALTER TABLE users ADD COLUMN IF NOT EXISTS client_access {col_type}"))
        conn.execute(
            text(f"ALTER TABLE client_invites ADD COLUMN IF NOT EXISTS client_access {col_type}")
        )
    print(f"Ensured users.client_access and client_invites.client_access ({col_type}).")


def main() -> int:
    try:
        _ensure_columns()
    except Exception as exc:
        print(f"Column ensure failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1

    db = SessionLocal()
    try:
        rows = (
            db.query(User)
            .filter(User.role == RoleEnum.client)
            .all()
        )
        upgraded = 0
        for user in rows:
            existing = getattr(user, "client_access", None)
            if isinstance(existing, list) and len(existing) > 0:
                continue
            access = client_access_from_legacy(user.client_name, user.client_areas)
            if not access:
                continue
            user.client_access = access
            name, areas = legacy_fields_from_access(access)
            user.client_name = name
            user.client_areas = areas
            upgraded += 1
        db.commit()
        print(f"Upgraded {upgraded} client user(s) to client_access.")
        return 0
    except Exception as exc:
        db.rollback()
        print(f"Migration failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
