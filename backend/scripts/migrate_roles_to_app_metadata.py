"""One-time migration: copy every Supabase user's role/name from the
user-editable `user_metadata` into the admin-only `app_metadata`.

WHY THIS IS REQUIRED, AND WHY IT MUST RUN BEFORE THE NEW BACKEND DEPLOYS
-------------------------------------------------------------------------
`app/auth.py` used to trust `user_metadata.role` to decide what a caller
is allowed to do. Any signed-in user can edit their own `user_metadata`
via `supabase.auth.updateUser()`, so that was a self-promotion hole (a
worker could grant themselves `role: admin`).

The fix makes the backend trust `app_metadata` ONLY — a field that can
only be written via the Supabase Admin API (service-role key), which only
this backend holds. `app/auth.py` treats a caller with no `app_metadata.role`
as a plain `worker`, never anything higher.

That means: if you deploy the new `app/auth.py` WITHOUT running this
script first, every existing admin/office/crew_lead/tv account gets
silently downgraded to `worker` on their next request (locked out of
their normal permissions) — even though nothing about the account itself
changed. This script prevents that by copying each user's *current*
effective role/name into `app_metadata` first.

Usage (from the backend venv, with production Supabase creds in .env or
the shell environment):

    cd backend
    python scripts/migrate_roles_to_app_metadata.py            # dry run (prints only)
    python scripts/migrate_roles_to_app_metadata.py --apply    # actually writes

Safe to re-run: for each user it only writes `app_metadata` when the
role/name found there differs from what `user_metadata` currently says,
and it never touches `client_name`/`client_areas` (those are new fields
with no legacy equivalent — set them via the "Invite Client" flow).
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Allow running as `python scripts/migrate_roles_to_app_metadata.py`
# without installing the package.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from supabase import create_client  # noqa: E402

from app.config import get_settings  # noqa: E402

VALID_ROLES = {"admin", "office", "crew_lead", "worker", "tv", "client"}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Actually write app_metadata. Without this flag, only prints what would change.",
    )
    args = parser.parse_args()

    settings = get_settings()
    if not settings.supabase_url or not settings.supabase_service_role_key:
        print("ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in the environment.")
        sys.exit(1)

    client = create_client(settings.supabase_url, settings.supabase_service_role_key)

    result = client.auth.admin.list_users()
    users = result if isinstance(result, list) else (getattr(result, "users", None) or result or [])

    to_update = []
    for u in users:
        if getattr(u, "deleted_at", None):
            continue  # soft-deleted — nothing to migrate
        user_metadata = getattr(u, "user_metadata", None) or {}
        app_metadata = getattr(u, "app_metadata", None) or {}

        if app_metadata.get("role"):
            continue  # already migrated

        role = user_metadata.get("role") or "worker"
        if role not in VALID_ROLES:
            print(f"  WARNING: {u.email} has unrecognized role '{role}' in user_metadata — defaulting to 'worker'")
            role = "worker"
        name = user_metadata.get("name") or (u.email.split("@")[0].title() if u.email else "")

        to_update.append((u.id, u.email, role, name))

    if not to_update:
        print("Nothing to migrate — every user already has app_metadata.role set.")
        return

    print(f"Found {len(to_update)} user(s) needing app_metadata migration:\n")
    for user_id, email, role, name in to_update:
        print(f"  {email:40s}  role={role:10s}  name={name}")

    if not args.apply:
        print("\nDry run only — re-run with --apply to write these changes.")
        return

    print("\nApplying...")
    failures = []
    for user_id, email, role, name in to_update:
        try:
            client.auth.admin.update_user_by_id(
                user_id,
                {"app_metadata": {"role": role, "name": name}},
            )
            print(f"  OK: {email}")
        except Exception as exc:  # noqa: BLE001
            failures.append((email, str(exc)))
            print(f"  FAILED: {email} — {exc}")

    print(f"\nDone. {len(to_update) - len(failures)} succeeded, {len(failures)} failed.")
    if failures:
        print("Re-run this script to retry the failed ones (already-migrated users are skipped).")
        sys.exit(1)


if __name__ == "__main__":
    main()
