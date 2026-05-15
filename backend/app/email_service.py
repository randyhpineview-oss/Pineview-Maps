"""Email service for sending password reset codes and signup confirmations.

Two transports, picked per-call based on env vars:

- **Resend** (HTTPS) — preferred. Render's network blocks/throttles outbound
  SMTP (port 25 always, 587 unreliably even on paid plans), so a
  transactional email API over HTTPS is the only thing that works in
  production. Set RESEND_API_KEY + RESEND_FROM_EMAIL to enable.
- **SMTP via aiosmtplib** — fallback for local dev or self-hosted deploys
  where outbound 587 is open. Set SMTP_USER + SMTP_PASSWORD.

If neither is configured, the message is printed to stdout (dev mode) so
forgot-password and worker signup don't crash on a fresh local install.
"""

from __future__ import annotations

from datetime import datetime
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

import aiosmtplib
import httpx

from app.config import get_settings

settings = get_settings()


async def _send_via_resend(subject: str, to_email: str, text_body: str, html_body: str) -> None:
    """POST the email through Resend's REST API. Raises on non-2xx."""
    from_email = settings.resend_from_email or settings.smtp_from_email or settings.smtp_user
    if not from_email:
        raise RuntimeError(
            "Resend is configured but no from-address is set. "
            "Set RESEND_FROM_EMAIL (e.g. noreply@pineviewmaps.com)."
        )
    payload = {
        "from": f"{settings.smtp_from_name} <{from_email}>",
        "to": [to_email],
        "subject": subject,
        "text": text_body,
        "html": html_body,
    }
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(
            "https://api.resend.com/emails",
            headers={
                "Authorization": f"Bearer {settings.resend_api_key}",
                "Content-Type": "application/json",
            },
            json=payload,
        )
    if resp.status_code >= 300:
        # Surface Resend's error verbatim so the admin panel can show e.g.
        # "domain not verified" or "rate limit exceeded".
        raise RuntimeError(f"Resend API {resp.status_code}: {resp.text}")


async def _send_via_smtp(subject: str, to_email: str, text_body: str, html_body: str) -> None:
    """Send via aiosmtplib. 15s timeout so a hung connection fails fast."""
    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = f"{settings.smtp_from_name} <{settings.smtp_from_email or settings.smtp_user}>"
    msg["To"] = to_email
    msg.attach(MIMEText(text_body, "plain"))
    msg.attach(MIMEText(html_body, "html"))
    await aiosmtplib.send(
        msg,
        hostname=settings.smtp_host,
        port=settings.smtp_port,
        start_tls=True,
        username=settings.smtp_user,
        password=settings.smtp_password,
        timeout=15,
    )


def email_transport_configured() -> bool:
    """True if any usable email transport (Resend or SMTP) is configured."""
    if settings.resend_api_key:
        return True
    if settings.smtp_user and settings.smtp_password:
        return True
    return False


async def _dispatch(subject: str, to_email: str, text_body: str, html_body: str, *, dev_label: str) -> None:
    """Route an email through the best available transport."""
    if settings.resend_api_key:
        try:
            await _send_via_resend(subject, to_email, text_body, html_body)
            return
        except Exception as e:
            print(f"Failed to send {dev_label} to {to_email} via Resend: {e}")
            raise

    if settings.smtp_user and settings.smtp_password:
        try:
            await _send_via_smtp(subject, to_email, text_body, html_body)
            return
        except Exception as e:
            print(f"Failed to send {dev_label} to {to_email} via SMTP: {e}")
            raise

    # Dev fallback: log the message so password reset / signup still works
    # against a fresh local checkout with no SMTP or Resend configured.
    print(f"\n{'=' * 60}\n{dev_label.upper()} for {to_email}\n{text_body}\n{'=' * 60}\n")


async def send_password_reset_code(email: str, code: str) -> None:
    """Send a 6-digit password reset code to the user's email.
    
    Args:
        email: The recipient's email address
        code: The 6-digit reset code
    
    Raises:
        Exception: If email sending fails
    """
    # Format code with spaces for readability (e.g., "123 456")
    formatted_code = f"{code[:3]} {code[3:]}"

    subject = "Your Pineview Maps Password Reset Code"
    
    # Plain text version
    text_body = f"""Your Pineview Maps Password Reset Code

Your 6-digit reset code is: {formatted_code}

This code will expire in 10 minutes.

If you didn't request this code, you can safely ignore this email.

---
Pineview Maps
Field Mapping & Collaboration
"""

    # HTML version
    html_body = f"""<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Password Reset Code</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f3f4f6;">
    <table role="presentation" style="width: 100%; border-collapse: collapse;">
        <tr>
            <td align="center" style="padding: 40px 0;">
                <table role="presentation" style="width: 600px; border-collapse: collapse; background-color: #ffffff; border-radius: 8px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
                    <!-- Header -->
                    <tr>
                        <td style="padding: 40px 30px; text-align: center; background: linear-gradient(135deg, #2563eb, #4f46e5); border-radius: 8px 8px 0 0;">
                            <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 600;">Pineview Maps</h1>
                            <p style="margin: 8px 0 0 0; color: rgba(255,255,255,0.9); font-size: 14px;">Field Mapping & Collaboration</p>
                        </td>
                    </tr>
                    
                    <!-- Content -->
                    <tr>
                        <td style="padding: 40px 30px;">
                            <h2 style="margin: 0 0 20px 0; color: #111827; font-size: 20px; font-weight: 600;">Password Reset Code</h2>
                            <p style="margin: 0 0 24px 0; color: #4b5563; font-size: 16px; line-height: 1.5;">
                                You requested a password reset for your Pineview Maps account. Use the code below to reset your password:
                            </p>
                            
                            <!-- Code Box -->
                            <table role="presentation" style="width: 100%; margin: 24px 0;">
                                <tr>
                                    <td align="center">
                                        <div style="background-color: #f3f4f6; border: 2px solid #e5e7eb; border-radius: 8px; padding: 24px 40px; display: inline-block;">
                                            <span style="font-family: 'Courier New', monospace; font-size: 32px; font-weight: 700; letter-spacing: 8px; color: #111827;">{formatted_code}</span>
                                        </div>
                                    </td>
                                </tr>
                            </table>
                            
                            <p style="margin: 24px 0 0 0; color: #6b7280; font-size: 14px; line-height: 1.5;">
                                <strong style="color: #dc2626;">This code will expire in 10 minutes.</strong><br>
                                Enter this code on the login page to reset your password.
                            </p>
                            
                            <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 32px 0;">
                            
                            <p style="margin: 0; color: #9ca3af; font-size: 13px; line-height: 1.5;">
                                If you didn't request this code, you can safely ignore this email. Your password will remain unchanged.
                            </p>
                        </td>
                    </tr>
                    
                    <!-- Footer -->
                    <tr>
                        <td style="padding: 20px 30px; text-align: center; background-color: #f9fafb; border-radius: 0 0 8px 8px;">
                            <p style="margin: 0; color: #9ca3af; font-size: 12px;">
                                Pineview Maps &copy; {__import__('datetime').datetime.now().year}<br>
                                Secure authentication powered by Supabase
                            </p>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>"""

    await _dispatch(subject, email, text_body, html_body, dev_label=f"password reset code {code}")


async def send_signup_confirmation(email: str, confirmation_url: str, name: str) -> None:
    """Send a welcome / email-confirmation message to a newly-signed-up worker.

    Args:
        email: The recipient's email address
        confirmation_url: Supabase Admin API-generated signup confirmation link
        name: The worker's display name (shown in the greeting)

    Raises:
        Exception: If email sending fails
    """
    display_name = name or (email.split("@")[0].title() if email else "there")
    subject = "Welcome to Pineview Maps — Confirm your email"

    text_body = f"""Welcome to Pineview Maps, {display_name}!

Please confirm your email address by opening this link:

{confirmation_url}

This link expires in 24 hours. If you didn't create a Pineview Maps account,
you can safely ignore this email.

---
Pineview Maps
Field Mapping & Collaboration
"""

    html_body = f"""<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Confirm your Pineview Maps account</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f3f4f6;">
    <table role="presentation" style="width: 100%; border-collapse: collapse;">
        <tr>
            <td align="center" style="padding: 40px 0;">
                <table role="presentation" style="width: 600px; border-collapse: collapse; background-color: #ffffff; border-radius: 8px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
                    <tr>
                        <td style="padding: 40px 30px; text-align: center; background: linear-gradient(135deg, #2563eb, #4f46e5); border-radius: 8px 8px 0 0;">
                            <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 600;">Pineview Maps</h1>
                            <p style="margin: 8px 0 0 0; color: rgba(255,255,255,0.9); font-size: 14px;">Field Mapping & Collaboration</p>
                        </td>
                    </tr>
                    <tr>
                        <td style="padding: 40px 30px;">
                            <h2 style="margin: 0 0 20px 0; color: #111827; font-size: 20px; font-weight: 600;">Welcome, {display_name}!</h2>
                            <p style="margin: 0 0 24px 0; color: #4b5563; font-size: 16px; line-height: 1.5;">
                                Thanks for signing up. Please confirm your email address to activate your account and log in.
                            </p>

                            <table role="presentation" style="width: 100%; margin: 24px 0;">
                                <tr>
                                    <td align="center">
                                        <a href="{confirmation_url}" style="display: inline-block; background: linear-gradient(135deg, #2563eb, #4f46e5); color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600; font-size: 16px;">
                                            Confirm my email
                                        </a>
                                    </td>
                                </tr>
                            </table>

                            <p style="margin: 24px 0 0 0; color: #6b7280; font-size: 14px; line-height: 1.5;">
                                Or paste this URL into your browser:<br>
                                <a href="{confirmation_url}" style="color: #2563eb; word-break: break-all;">{confirmation_url}</a>
                            </p>

                            <p style="margin: 16px 0 0 0; color: #6b7280; font-size: 14px; line-height: 1.5;">
                                <strong style="color: #dc2626;">This link expires in 24 hours.</strong>
                            </p>

                            <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 32px 0;">

                            <p style="margin: 0; color: #9ca3af; font-size: 13px; line-height: 1.5;">
                                If you didn't create a Pineview Maps account, you can safely ignore this email.
                            </p>
                        </td>
                    </tr>
                    <tr>
                        <td style="padding: 20px 30px; text-align: center; background-color: #f9fafb; border-radius: 0 0 8px 8px;">
                            <p style="margin: 0; color: #9ca3af; font-size: 12px;">
                                Pineview Maps &copy; {__import__('datetime').datetime.now().year}<br>
                                Secure authentication powered by Supabase
                            </p>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>"""

    await _dispatch(subject, email, text_body, html_body, dev_label=f"signup confirmation ({confirmation_url})")


async def send_password_setup_link(email: str, setup_url: str, name: str | None) -> None:
    """Send an admin-initiated "set your password" magic link.

    This replaces the old admin 6-digit-code workflow. The link goes
    straight to a "Set Your Password" screen on the frontend (which
    posts to /api/auth/setup-password with the embedded token), so the
    worker doesn't need to copy/paste a code or click "Forgot password"
    on the login page first.

    Args:
        email: The recipient's email address.
        setup_url: Frontend URL containing the single-use ``setup_token``
            query parameter, e.g. ``https://pineviewmaps.com/?setup_token=...``.
        name: Worker's display name; shown in the greeting. ``None``/empty
            falls back to the email's local part.

    Raises:
        Exception: If sending fails on the configured transport.
    """
    display_name = name or (email.split("@")[0].title() if email else "there")
    subject = "Set up your Pineview Maps password"

    text_body = f"""Hi {display_name},

An administrator has set up a Pineview Maps account for you. Click the
link below to choose your password and sign in:

{setup_url}

This link expires in 24 hours and can only be used once. If you weren't
expecting this email, you can safely ignore it.

---
Pineview Maps
Field Mapping & Collaboration
"""

    html_body = f"""<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Set up your Pineview Maps password</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f3f4f6;">
    <table role="presentation" style="width: 100%; border-collapse: collapse;">
        <tr>
            <td align="center" style="padding: 40px 0;">
                <table role="presentation" style="width: 600px; border-collapse: collapse; background-color: #ffffff; border-radius: 8px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
                    <tr>
                        <td style="padding: 40px 30px; text-align: center; background: linear-gradient(135deg, #2563eb, #4f46e5); border-radius: 8px 8px 0 0;">
                            <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 600;">Pineview Maps</h1>
                            <p style="margin: 8px 0 0 0; color: rgba(255,255,255,0.9); font-size: 14px;">Field Mapping & Collaboration</p>
                        </td>
                    </tr>
                    <tr>
                        <td style="padding: 40px 30px;">
                            <h2 style="margin: 0 0 20px 0; color: #111827; font-size: 20px; font-weight: 600;">Hi {display_name} — set your password</h2>
                            <p style="margin: 0 0 24px 0; color: #4b5563; font-size: 16px; line-height: 1.5;">
                                An administrator has set up a Pineview Maps account for you.
                                Click the button below to choose your password and sign in.
                            </p>

                            <table role="presentation" style="width: 100%; margin: 24px 0;">
                                <tr>
                                    <td align="center">
                                        <a href="{setup_url}" style="display: inline-block; background: linear-gradient(135deg, #2563eb, #4f46e5); color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600; font-size: 16px;">
                                            Set my password
                                        </a>
                                    </td>
                                </tr>
                            </table>

                            <p style="margin: 24px 0 0 0; color: #6b7280; font-size: 14px; line-height: 1.5;">
                                Or paste this URL into your browser:<br>
                                <a href="{setup_url}" style="color: #2563eb; word-break: break-all;">{setup_url}</a>
                            </p>

                            <p style="margin: 16px 0 0 0; color: #6b7280; font-size: 14px; line-height: 1.5;">
                                <strong style="color: #dc2626;">This link expires in 24 hours and can only be used once.</strong>
                            </p>

                            <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 32px 0;">

                            <p style="margin: 0; color: #9ca3af; font-size: 13px; line-height: 1.5;">
                                If you weren't expecting this email, you can safely ignore it — your account
                                stays inactive until someone uses this link.
                            </p>
                        </td>
                    </tr>
                    <tr>
                        <td style="padding: 20px 30px; text-align: center; background-color: #f9fafb; border-radius: 0 0 8px 8px;">
                            <p style="margin: 0; color: #9ca3af; font-size: 12px;">
                                Pineview Maps &copy; {__import__('datetime').datetime.now().year}<br>
                                Secure authentication powered by Supabase
                            </p>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>"""

    await _dispatch(subject, email, text_body, html_body, dev_label=f"password setup link ({setup_url})")


# ──────────────────────────────────────────────────────────────────────
# Lone-worker check-in alert emails (Phase 2 unified)
# ──────────────────────────────────────────────────────────────────────
# Three templates layered on top of the existing _dispatch() pipeline:
#
#   send_checkin_reminder_email   Worker T-15 / T+0 / T+3 / repeats.
#                                 Only sent when notify_email=true on
#                                 the user_profile (push is primary).
#
#   send_office_overdue_email_standard   Office alert at T+30.
#                                        Neutral tone, blue header.
#
#   send_office_overdue_email_urgent     Office alert at T+60.
#                                        Red header, URGENT subject,
#                                        bigger numbers, CTA button.
#
# The HTML follows the same table-based layout as the existing reset/
# signup templates so Outlook + iOS Mail render identically.


_CHECKIN_KIND_COPY: dict[str, dict[str, str]] = {
    # Maps the kind (as stored in checkin_alerts.kind) to subject +
    # short body text. Keeps the routes file from holding marketing
    # copy and lets us tweak phrasing in one place.
    "worker_t-15": {
        "subject": "Check-in due in 15 minutes",
        "headline": "Heads-up: check-in due in 15 minutes",
        "body": (
            "Just a reminder that your next Pineview check-in is due in "
            "about 15 minutes. Tap I'm OK whenever you have a free moment."
        ),
    },
    "worker_t0": {
        "subject": "Check-in due now",
        "headline": "Time to check in",
        "body": (
            "Your Pineview check-in is due right now. Open the app and "
            "tap I'm OK to confirm you're safe."
        ),
    },
    "worker_overdue_3": {
        "subject": "Check-in overdue — please confirm you're OK",
        "headline": "Check-in OVERDUE",
        "body": (
            "You're a few minutes overdue on your Pineview check-in. "
            "Please open the app and tap I'm OK as soon as you can — "
            "if we don't hear from you, the office will be notified."
        ),
    },
}


async def send_checkin_reminder_email(
    to_email: str,
    *,
    worker_name: str,
    kind: str,
    due_at: datetime | None = None,  # noqa: F821 (datetime imported below via fallback)
) -> None:
    """Send a worker-facing check-in reminder.

    Args:
        to_email:     The worker's notification email (may differ from
                      their auth email if they set notify_email_address).
        worker_name:  Display name for the greeting.
        kind:         One of ``worker_t-15`` / ``worker_t0`` /
                      ``worker_overdue_3`` / ``worker_overdue_repeat_N``.
                      Repeat kinds are mapped to the overdue copy.
        due_at:       Optional deadline timestamp; included in the
                      body when present so the worker knows the exact
                      time (handy for sleep-mode notifications).
    """
    # Repeat kinds (worker_overdue_repeat_N) reuse the T+3 copy so we
    # don't need a separate template per N.
    copy = _CHECKIN_KIND_COPY.get(kind) or _CHECKIN_KIND_COPY["worker_overdue_3"]
    subject = copy["subject"]
    display_name = worker_name or (to_email.split("@")[0].title() if to_email else "there")
    due_str = due_at.strftime("%I:%M %p") if due_at else ""

    text_body = f"""Hi {display_name},

{copy["body"]}

{('Deadline: ' + due_str) if due_str else ''}

Open Pineview Maps and tap "I'm OK" to record your check-in.

---
Pineview Maps · Lone-worker safety
"""

    html_body = f"""<!DOCTYPE html>
<html><body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f3f4f6;">
  <table role="presentation" style="width:100%;border-collapse:collapse;">
    <tr><td align="center" style="padding:32px 12px;">
      <table role="presentation" style="width:560px;max-width:96%;border-collapse:collapse;background:#fff;border-radius:8px;box-shadow:0 4px 6px rgba(0,0,0,.08);">
        <tr><td style="padding:28px 28px 12px 28px;background:linear-gradient(135deg,#2563eb,#4f46e5);border-radius:8px 8px 0 0;">
          <h1 style="margin:0;color:#fff;font-size:20px;font-weight:600;">Pineview Maps</h1>
          <p style="margin:6px 0 0 0;color:rgba(255,255,255,.85);font-size:13px;">Lone-worker safety reminder</p>
        </td></tr>
        <tr><td style="padding:28px;">
          <h2 style="margin:0 0 16px 0;color:#111827;font-size:18px;">{copy["headline"]}</h2>
          <p style="margin:0 0 16px 0;color:#374151;font-size:15px;line-height:1.5;">Hi {display_name},</p>
          <p style="margin:0 0 16px 0;color:#374151;font-size:15px;line-height:1.5;">{copy["body"]}</p>
          {f'<p style="margin:0 0 16px 0;color:#6b7280;font-size:14px;"><strong>Deadline:</strong> {due_str}</p>' if due_str else ''}
          <p style="margin:24px 0 0 0;color:#6b7280;font-size:13px;line-height:1.5;">Open the Pineview Maps app and tap <strong>I'm OK</strong> to record your check-in.</p>
        </td></tr>
        <tr><td style="padding:14px 28px;text-align:center;background:#f9fafb;border-radius:0 0 8px 8px;color:#9ca3af;font-size:12px;">
          Pineview Maps · Lone-worker safety
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>"""

    await _dispatch(subject, to_email, text_body, html_body, dev_label=f"checkin reminder {kind}")


async def send_office_overdue_email_standard(
    to_email: str,
    *,
    worker_name: str,
    mode: str,
    crew_names: str,
    deadline_at: datetime | None = None,
    minutes_overdue: int = 30,
    dashboard_url: str = "",
) -> None:
    """First office alert: standard tone, sent at T+30.

    Args:
        to_email:        Recipient (one row from office_alert_recipients).
        worker_name:     Display name of the overdue worker.
        mode:            'alone' / 'crew' — shown so office knows the
                         safety context (alone is more urgent).
        crew_names:      Comma-joined crew names when applicable, else ''.
        deadline_at:     The deadline they missed (for context).
        minutes_overdue: How long they've been overdue.
        dashboard_url:   Link to the Check-ins Dashboard.
    """
    subject = f"{worker_name} is {minutes_overdue} minutes overdue"
    due_str = deadline_at.strftime("%I:%M %p") if deadline_at else ""
    crew_line = f"Crew: {crew_names}" if crew_names else f"Mode: {mode.title()}"

    text_body = f"""Pineview check-in alert (standard)

{worker_name} has not checked in for {minutes_overdue} minutes past their deadline.

{crew_line}
{('Missed deadline: ' + due_str) if due_str else ''}

Open the Check-ins Dashboard to see live status and take action:
{dashboard_url}

---
Pineview Maps · Lone-worker safety
"""

    html_body = f"""<!DOCTYPE html>
<html><body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f3f4f6;">
  <table role="presentation" style="width:100%;border-collapse:collapse;">
    <tr><td align="center" style="padding:32px 12px;">
      <table role="presentation" style="width:560px;max-width:96%;border-collapse:collapse;background:#fff;border-radius:8px;box-shadow:0 4px 6px rgba(0,0,0,.08);">
        <tr><td style="padding:28px 28px 14px 28px;background:linear-gradient(135deg,#2563eb,#4f46e5);border-radius:8px 8px 0 0;">
          <h1 style="margin:0;color:#fff;font-size:20px;font-weight:600;">Pineview check-in alert</h1>
          <p style="margin:6px 0 0 0;color:rgba(255,255,255,.85);font-size:13px;">Worker overdue notification</p>
        </td></tr>
        <tr><td style="padding:28px;">
          <p style="margin:0 0 12px 0;color:#374151;font-size:16px;line-height:1.5;">
            <strong style="color:#111827;font-size:18px;">{worker_name}</strong> has not checked in for
            <strong style="color:#b45309;">{minutes_overdue} minutes</strong> past their deadline.
          </p>
          <p style="margin:0 0 12px 0;color:#4b5563;font-size:14px;">{crew_line}</p>
          {f'<p style="margin:0 0 16px 0;color:#6b7280;font-size:14px;"><strong>Missed deadline:</strong> {due_str}</p>' if due_str else ''}
          {f'<table role="presentation" style="margin:18px 0 0 0;"><tr><td><a href="{dashboard_url}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:10px 22px;border-radius:6px;font-weight:600;font-size:14px;">Open dashboard</a></td></tr></table>' if dashboard_url else ''}
          <p style="margin:24px 0 0 0;color:#9ca3af;font-size:12px;line-height:1.5;">A second, urgent alert will be sent at T+60 if {worker_name} still hasn't checked in.</p>
        </td></tr>
        <tr><td style="padding:14px 28px;text-align:center;background:#f9fafb;border-radius:0 0 8px 8px;color:#9ca3af;font-size:12px;">
          Pineview Maps · Lone-worker safety
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>"""

    await _dispatch(subject, to_email, text_body, html_body, dev_label=f"office overdue standard ({worker_name}, +{minutes_overdue}m)")


async def send_office_overdue_email_urgent(
    to_email: str,
    *,
    worker_name: str,
    mode: str,
    crew_names: str,
    deadline_at: datetime | None = None,
    minutes_overdue: int = 60,
    dashboard_url: str = "",
) -> None:
    """Escalated office alert: red banner, sent at T+60.

    Subject is prefixed with 🚨 URGENT so it sorts to the top of inbox
    views and pings differently on mobile mail apps (most show emoji
    in the lock-screen notification).
    """
    subject = f"🚨 URGENT: {worker_name} is 1 hour overdue"
    due_str = deadline_at.strftime("%I:%M %p") if deadline_at else ""
    crew_line = f"Crew: {crew_names}" if crew_names else f"Mode: {mode.title()}"

    text_body = f"""URGENT: Pineview check-in escalation

{worker_name} has not checked in for {minutes_overdue} minutes past their deadline.

{crew_line}
{('Missed deadline: ' + due_str) if due_str else ''}

This is the SECOND alert. Please attempt to contact {worker_name} directly
(phone, radio, dispatch) and verify they are safe.

Open the Check-ins Dashboard to see live status:
{dashboard_url}

---
Pineview Maps · Lone-worker safety
"""

    html_body = f"""<!DOCTYPE html>
<html><body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#fef2f2;">
  <table role="presentation" style="width:100%;border-collapse:collapse;">
    <tr><td align="center" style="padding:32px 12px;">
      <table role="presentation" style="width:560px;max-width:96%;border-collapse:collapse;background:#fff;border-radius:8px;box-shadow:0 4px 12px rgba(220,38,38,.18);border:2px solid #dc2626;">
        <tr><td style="padding:28px 28px 18px 28px;background:linear-gradient(135deg,#dc2626,#991b1b);border-radius:6px 6px 0 0;">
          <h1 style="margin:0;color:#fff;font-size:22px;font-weight:700;letter-spacing:.5px;">🚨 URGENT</h1>
          <p style="margin:6px 0 0 0;color:rgba(255,255,255,.95);font-size:14px;font-weight:500;">Worker 1 hour overdue</p>
        </td></tr>
        <tr><td style="padding:28px;">
          <p style="margin:0 0 12px 0;color:#111827;font-size:18px;line-height:1.4;">
            <strong style="font-size:22px;color:#dc2626;">{worker_name}</strong>
          </p>
          <p style="margin:0 0 16px 0;color:#111827;font-size:16px;line-height:1.5;">
            Has not checked in for <strong style="color:#dc2626;font-size:18px;">{minutes_overdue} minutes</strong> past their deadline.
          </p>
          <p style="margin:0 0 12px 0;color:#4b5563;font-size:14px;">{crew_line}</p>
          {f'<p style="margin:0 0 18px 0;color:#6b7280;font-size:14px;"><strong>Missed deadline:</strong> {due_str}</p>' if due_str else ''}
          <div style="background:#fef2f2;border-left:4px solid #dc2626;padding:14px 16px;margin:18px 0;border-radius:4px;">
            <p style="margin:0;color:#991b1b;font-size:14px;line-height:1.5;font-weight:600;">
              Please attempt to contact {worker_name} directly (phone, radio, dispatch) and verify they are safe.
            </p>
          </div>
          {f'<table role="presentation" style="margin:18px 0 0 0;"><tr><td><a href="{dashboard_url}" style="display:inline-block;background:#dc2626;color:#fff;text-decoration:none;padding:12px 28px;border-radius:6px;font-weight:700;font-size:15px;">Open dashboard</a></td></tr></table>' if dashboard_url else ''}
        </td></tr>
        <tr><td style="padding:14px 28px;text-align:center;background:#fef2f2;border-radius:0 0 6px 6px;color:#991b1b;font-size:12px;font-weight:500;">
          Pineview Maps · Lone-worker safety · Urgent escalation
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>"""

    await _dispatch(subject, to_email, text_body, html_body, dev_label=f"office overdue URGENT ({worker_name}, +{minutes_overdue}m)")
