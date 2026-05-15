"""Generate a VAPID keypair for Web Push (lone-worker check-in feature).

Run ONCE per deployment; copy the printed values into the BACKEND env
vars (VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_CONTACT_EMAIL).

The frontend does NOT need its own copy -- pushClient.js fetches the
public key at runtime from /api/checkins/vapid-public-key. One source of
truth, no key drift between frontend and backend deploys.

Both keys are emitted in **base64url** form (no padding) which is what:

  - the browser's `pushManager.subscribe({ applicationServerKey })` expects
    for the public key, and
  - pywebpush's `vapid_private_key=` parameter accepts for the private
    key (it auto-detects PEM vs base64url, and base64url is friendlier
    for .env files because it has no newlines).

Usage (from the backend venv):

  cd backend
  .venv\\Scripts\\Activate.ps1     # Windows PowerShell
  pip install -r requirements.txt  # ensures pywebpush + py_vapid installed
  python scripts\\generate_vapid_keys.py

The script prints something like:

  VAPID_PUBLIC_KEY=BNcRdreALRFXTkOuuk... (88 chars)
  VAPID_PRIVATE_KEY=mLtNvbLDhYj9TY...    (43 chars)

Save those values somewhere safe -- you cannot regenerate the same pair,
so losing the private key means every subscribed device has to re-pair.
"""
from __future__ import annotations

import base64

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec


def b64url(data: bytes) -> str:
    """Standard base64url encoding without padding -- what Web Push wants."""
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def main() -> None:
    # 1) Generate a P-256 (secp256r1) EC keypair -- the only curve Web Push
    #    supports.
    private_key = ec.generate_private_key(ec.SECP256R1())
    public_key = private_key.public_key()

    # 2) Public key as 65-byte uncompressed point (0x04 || X || Y).
    #    This is the format both the browser and pywebpush expect.
    public_bytes = public_key.public_bytes(
        encoding=serialization.Encoding.X962,
        format=serialization.PublicFormat.UncompressedPoint,
    )
    public_b64 = b64url(public_bytes)

    # 3) Private key as raw 32-byte scalar `d`. pywebpush's
    #    Vapid.from_string() detects this (no newlines) and rebuilds the
    #    EC private key internally.
    d_int = private_key.private_numbers().private_value
    d_bytes = d_int.to_bytes(32, "big")
    private_b64 = b64url(d_bytes)

    # 4) Also emit the PEM form for anyone who prefers files over env vars.
    private_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("ascii")

    print("# ─── Copy these three lines into the BACKEND env config ────")
    print(f"VAPID_PUBLIC_KEY={public_b64}")
    print(f"VAPID_PRIVATE_KEY={private_b64}")
    print(f"VAPID_CONTACT_EMAIL=mailto:admin@example.com   # change to your inbox")
    print()
    print("# Frontend reads the public key from /api/checkins/vapid-public-key")
    print("# at runtime, so no VITE_ env var is required.")
    print()
    print("# ─── PEM form of the private key (alternative to base64url) ─")
    print(private_pem)


if __name__ == "__main__":
    main()
