"""Shared logging helpers.

Consolidates the backend's approach to log emission and PII masking.
Render captures stdout/stderr for the web service, so stdlib `logging`
output appears in the Render dashboard with no extra wiring.

Two helpers are exposed:

- ``get_logger(name)``: factory matching the stdlib convention. Use
  ``logger = get_logger(__name__)`` at the top of every module that used
  to call ``print()`` for diagnostics.
- ``mask_email(email)``: collapse the local part of an email down to its
  first two characters so logs remain triage-able without leaking full
  addresses. An operator can still tell that two events came from the
  same inbox (same prefix + domain) while the raw address stays off disk.
"""

from __future__ import annotations

import hashlib
import logging
from typing import Any, Optional


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)


def mask_email(email: Optional[str]) -> str:
    """Return a log-safe rendering of an email address.

    Examples:
        ``randy.hanks@pineview.com`` -> ``ra***@pineview.com``
        ``ab@x.com``                  -> ``a***@x.com``
        ``""`` or ``None``            -> ``(unknown)``
    """
    if not email or "@" not in email:
        return "(unknown)"
    local, _, domain = email.partition("@")
    if len(local) <= 2:
        return f"{local[:1] or '?'}***@{domain}"
    return f"{local[:2]}***@{domain}"


def short_id(value: Any) -> str:
    """Return an 8-char SHA-256 prefix of ``value`` for correlation logging.

    Handy when we want to tie multiple log lines to the same entity
    (site, ticket, user row) without emitting the raw id or email.
    """
    if value is None:
        return "(none)"
    return hashlib.sha256(str(value).encode("utf-8")).hexdigest()[:8]
