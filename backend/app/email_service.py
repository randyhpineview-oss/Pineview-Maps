"""Email service for sending password reset codes.

Uses aiosmtplib for async email delivery.
"""

from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

import aiosmtplib

from app.config import get_settings

settings = get_settings()


async def send_password_reset_code(email: str, code: str) -> None:
    """Send a 6-digit password reset code to the user's email.
    
    Args:
        email: The recipient's email address
        code: The 6-digit reset code
    
    Raises:
        Exception: If email sending fails
    """
    if not settings.smtp_user or not settings.smtp_password:
        # In development, just print the code to console
        print(f"\n{'='*60}")
        print(f"PASSWORD RESET CODE for {email}")
        print(f"Code: {code}")
        print(f"{'='*60}\n")
        return

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

    # Create message
    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = f"{settings.smtp_from_name} <{settings.smtp_from_email or settings.smtp_user}>"
    msg["To"] = email

    # Attach parts
    msg.attach(MIMEText(text_body, "plain"))
    msg.attach(MIMEText(html_body, "html"))

    # Send email
    try:
        await aiosmtplib.send(
            msg,
            hostname=settings.smtp_host,
            port=settings.smtp_port,
            start_tls=True,
            username=settings.smtp_user,
            password=settings.smtp_password,
        )
    except Exception as e:
        # Log error and re-raise
        print(f"Failed to send email to {email}: {e}")
        raise
