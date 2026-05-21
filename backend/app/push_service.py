"""Web Push delivery via pywebpush.

One public helper -- ``send_push(subscription, payload)`` -- that signs
a JSON payload with the configured VAPID keypair and POSTs it to the
push endpoint registered by the worker's browser.

Failure handling:
  * 404 / 410   -> subscription is dead (worker uninstalled the PWA or
                   cleared site data). Delete the row and continue.
  * Other 4xx   -> log + raise. Likely a misconfiguration (wrong VAPID
                   key, bad payload format) that wants attention.
  * 5xx / net   -> log + raise. The scan endpoint catches and records
                   the failure in ``checkin_alerts.error`` so we can
                   see *which* push failed when triaging.

pywebpush is pure-Python so this works on Render without native build
deps. The library handles the AES-128-GCM encryption + the VAPID JWT
signing internally.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Optional

from pywebpush import WebPushException, webpush  # type: ignore[import-untyped]
from sqlalchemy.orm import Session

from app.checkin_models import PushSubscription
from app.config import get_settings
from app.log_util import get_logger

settings = get_settings()
logger = get_logger(__name__)


@dataclass
class PushPayload:
    """JSON payload posted to the SW.

    Mirrors the keys the ``push`` handler in ``frontend/src/sw-push.js``
    reads. Keep field names + meaning aligned with that file.
    """

    title: str
    body: str
    # Notification ``tag`` -- repeat alerts replace prior ones in the
    # OS tray when the tag matches. Default 'checkin' so every alert
    # is the same single notification visually (with renotify:true
    # making sure it still pings/vibrates each time).
    tag: str = "checkin"
    # Sets requireInteraction:true in the SW -- notification stays on
    # screen until tapped, doesn't auto-dismiss. Reserved for overdue
    # alerts (T+3 and beyond) per the cadence spec.
    urgent: bool = False
    # URL the notificationclick handler navigates to. Default '/'
    # opens the app shell; the SW posts a message to focus any open
    # tab onto the MyCheckIns overlay.
    url: str = "/"
    # Shift id (for traceability + possible "open this shift" deep
    # link). Optional -- frontend treats it as informational.
    shift_id: Optional[int] = None

    def to_json(self) -> str:
        return json.dumps(
            {
                "title": self.title,
                "body": self.body,
                "tag": self.tag,
                "urgent": self.urgent,
                "url": self.url,
                "shiftId": self.shift_id,
            }
        )


def push_configured() -> bool:
    """True iff the VAPID keypair is set. Caller treats False as a no-op."""
    return bool(
        settings.vapid_private_key
        and settings.vapid_public_key
        and settings.vapid_contact_email
    )


def vapid_sub_claim() -> str:
    """Build the VAPID JWT ``sub`` claim from the configured contact email.

    Tolerates both ``contact@example.com`` and ``mailto:contact@example.com``
    in the env var so a stray ``mailto:`` prefix in VAPID_CONTACT_EMAIL
    doesn't double up to ``mailto:mailto:...`` -- which Apple's Web Push
    gateway rejects as "Bad JWT token" (403). RFC 8292 requires the sub
    claim to be a valid mailto: or https: URI.
    """
    raw = (settings.vapid_contact_email or "").strip()
    if not raw:
        return ""
    lowered = raw.lower()
    if lowered.startswith("mailto:") or lowered.startswith("https:"):
        return raw
    return f"mailto:{raw}"


def send_push(
    db: Session,
    subscription: PushSubscription,
    payload: PushPayload,
    *,
    ttl: int = 60 * 60,
    urgency: str = "high",
) -> None:
    """POST an encrypted payload to a single subscription endpoint.

    Args:
        db:           SQLAlchemy session (needed for the 404/410
                      cleanup path).
        subscription: ORM row from ``push_subscriptions``.
        payload:      The notification payload.
        ttl:          Time-to-live in seconds. Default 1 h -- a push
                      that can't be delivered within an hour is stale
                      (worker probably checked in via another device).
        urgency:      RFC 8030 priority -- one of 'very-low', 'low',
                      'normal', 'high'. Default 'high' for this module
                      because every check-in push is time-sensitive
                      (worker is approaching / past a safety deadline)
                      and iOS / Android battery-saver paths will
                      otherwise delay delivery indefinitely on a phone
                      in low-power mode. The standard non-urgent push
                      can sit in a delivery queue for tens of minutes
                      on a sleeping iPhone; ``Urgency: high`` is the
                      one knob that bypasses that throttling.

    Raises ``WebPushException`` on non-recoverable errors so the caller
    can record the failure. Returns normally on success or on the
    expired-subscription cleanup path.
    """
    if not push_configured():
        logger.warning("send_push called but VAPID config missing -- skipping")
        return

    vapid_claims = {"sub": vapid_sub_claim()}
    sub_info = {
        "endpoint": subscription.endpoint,
        "keys": {
            "p256dh": subscription.p256dh,
            "auth": subscription.auth,
        },
    }
    # ``Urgency: high`` (RFC 8030) tells Apple/FCM to bypass their
    # battery / low-power delivery throttling. This is the documented
    # fix for "I installed the PWA on iOS but I don't get pushes when
    # my phone is locked" -- iOS only delivers normal-urgency pushes
    # opportunistically when the device is also doing other work, and
    # for a phone sitting in a worker's pocket that can mean hours of
    # delay. With Urgency:high the push attempts immediate delivery.
    extra_headers = {"Urgency": urgency} if urgency else None
    try:
        webpush(
            subscription_info=sub_info,
            data=payload.to_json(),
            vapid_private_key=settings.vapid_private_key,
            vapid_claims=vapid_claims,
            ttl=ttl,
            headers=extra_headers,
        )
    except WebPushException as exc:
        # pywebpush stuffs the upstream HTTP response on .response so
        # we can distinguish "subscription is dead" from "everything
        # else" without a string-match.
        status_code = getattr(exc.response, "status_code", None)
        # 404 / 410 -- endpoint expired (browser uninstalled or cleared).
        # 401 / 403 -- VAPID JWT rejected. The subscription was created
        # with a different VAPID public key than the one the backend is
        # currently signing with, so this row will *always* 403 here.
        # Delete it so the user gets prompted to re-subscribe afresh
        # next time they enable push, instead of the same broken row
        # erroring forever.
        if status_code in (401, 403, 404, 410):
            logger.info(
                "Push endpoint %s returned %s -- deleting subscription %s",
                _short(subscription.endpoint),
                status_code,
                subscription.id,
            )
            db.delete(subscription)
            db.commit()
            return
        logger.warning(
            "Push to subscription %s failed (status=%s): %s",
            subscription.id,
            status_code,
            exc,
        )
        raise


def _short(endpoint: str, *, n: int = 40) -> str:
    """Truncate an endpoint URL for log output (they're long opaque tokens)."""
    if len(endpoint) <= n:
        return endpoint
    return endpoint[: n - 1] + "…"
