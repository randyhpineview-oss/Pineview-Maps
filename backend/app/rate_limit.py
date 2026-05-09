"""Rate limiting for auth-adjacent endpoints.

slowapi-backed limiter keyed on the remote address. Used to cap:

- password reset code requests (prevents SMTP quota drain)
- password reset code verifications (second ring on top of the per-code
  DB attempt counter)
- password resets themselves
- worker self-signup

All limits are IP-based. slowapi key_func can't inspect the request body
(slowapi runs before FastAPI parses JSON), so per-email limits would
require a custom middleware. For the 20-user launch, IP limits are
sufficient: any legitimate user stays well under the caps, and anyone
trying to brute-force has to rotate IPs to get around them.

Storage is in-process. On Render Starter (single worker) that's fine; if
we ever scale to multiple workers the limits become per-worker. Upgrade
path is ``Limiter(storage_uri="redis://...")`` — no call-site changes.
"""

from __future__ import annotations

from slowapi import Limiter
from slowapi.util import get_remote_address


limiter = Limiter(key_func=get_remote_address)
