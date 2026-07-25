"""Client-role multi-company scope helpers.

Canonical shape stored on `users.client_access` / Supabase `app_metadata.client_access`
and on `client_invites.client_access`:

    [
      {"client": "FSJ Hospital", "areas": ["North", "South"]},  # restricted
      {"client": "City of Fort St. John", "areas": null},       # all areas
    ]

`areas` may be omitted, null, or [] — all mean "every area for that client".
Legacy single-client rows keep `client_name` + `client_areas`; readers should
call :func:`resolve_client_access` so both shapes work.
"""

from __future__ import annotations

from typing import Any, Optional


def clean_areas(raw: Any) -> Optional[list[str]]:
    """Normalize an areas list. Empty/missing → None (= unrestricted)."""
    if not isinstance(raw, list):
        return None
    cleaned = [a.strip() for a in raw if isinstance(a, str) and a.strip()]
    return cleaned or None


def clean_client_access(raw: Any) -> Optional[list[dict]]:
    """Normalize a client_access payload to ``[{client, areas}]`` or None.

    Dedupes by case-insensitive client name (first wins). Drops empty client
    strings. ``areas`` is always either a non-empty list or None.
    """
    if not isinstance(raw, list):
        return None
    out: list[dict] = []
    seen: set[str] = set()
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        raw_client = entry.get("client") or entry.get("client_name")
        if not isinstance(raw_client, str):
            continue
        client = raw_client.strip()
        if not client:
            continue
        key = client.lower()
        if key in seen:
            continue
        seen.add(key)
        areas = clean_areas(entry.get("areas") if "areas" in entry else entry.get("client_areas"))
        out.append({"client": client, "areas": areas})
    return out or None


def client_access_from_legacy(
    client_name: Optional[str],
    client_areas: Any = None,
) -> Optional[list[dict]]:
    """Build a one-entry client_access list from legacy fields."""
    if not isinstance(client_name, str):
        return None
    name = client_name.strip()
    if not name:
        return None
    return [{"client": name, "areas": clean_areas(client_areas)}]


def resolve_client_access(
    *,
    client_access: Any = None,
    client_name: Optional[str] = None,
    client_areas: Any = None,
) -> list[dict]:
    """Prefer structured ``client_access``; else legacy ``client_name``/``client_areas``.

    Returns an empty list when no scope is configured (callers should treat
    that as "see nothing" for the client role).
    """
    cleaned = clean_client_access(client_access)
    if cleaned:
        return cleaned
    legacy = client_access_from_legacy(client_name, client_areas)
    return legacy or []


def resolve_user_client_access(user: Any) -> list[dict]:
    """Resolve scope from a User ORM object / duck-typed stand-in."""
    return resolve_client_access(
        client_access=getattr(user, "client_access", None),
        client_name=getattr(user, "client_name", None),
        client_areas=getattr(user, "client_areas", None),
    )


def legacy_fields_from_access(access: Optional[list[dict]]) -> tuple[Optional[str], Optional[list[str]]]:
    """Mirror fields for back-compat readers that only know client_name/areas.

    Single-client: full fidelity (name + that entry's areas).
    Multi-client: first client name + ``client_areas=None`` (areas are
    per-client and can't be represented in the flat field).
    """
    cleaned = clean_client_access(access)
    if not cleaned:
        return None, None
    first = cleaned[0]
    if len(cleaned) == 1:
        return first["client"], first.get("areas")
    return first["client"], None


def display_client_names(access: Optional[list[dict]]) -> str:
    """Human-readable company list for UI / signup copy."""
    cleaned = clean_client_access(access) or []
    return ", ".join(entry["client"] for entry in cleaned)


def build_scope_app_metadata(access: Optional[list[dict]]) -> dict:
    """Keys to merge into Supabase ``app_metadata`` for a client account.

    Always writes ``client_access`` when present. Also mirrors legacy
    ``client_name`` / ``client_areas`` so older JWTs/tools keep working.
    Omits keys rather than writing JSON null when unset.
    """
    cleaned = clean_client_access(access)
    meta: dict = {}
    if not cleaned:
        return meta
    meta["client_access"] = cleaned
    name, areas = legacy_fields_from_access(cleaned)
    if name:
        meta["client_name"] = name
    if areas:
        meta["client_areas"] = areas
    elif len(cleaned) == 1:
        # Explicit unrestricted single-client: leave client_areas absent
        # (same conservative choice as the original invite_client).
        pass
    return meta


def parse_scope_payload(
    *,
    client_access: Any = None,
    client_name: Optional[str] = None,
    client_areas: Any = None,
    require_at_least_one: bool = True,
) -> list[dict]:
    """Normalize an invite/update payload that may send either shape.

    Raises ``ValueError`` with a user-facing message when invalid.
    """
    cleaned = clean_client_access(client_access)
    if cleaned is None and client_name is not None:
        cleaned = client_access_from_legacy(client_name, client_areas)
    if require_at_least_one and not cleaned:
        raise ValueError("Select at least one client company.")
    return cleaned or []
