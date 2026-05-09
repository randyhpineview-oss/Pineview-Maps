from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict
import os


class Settings(BaseSettings):
    app_name: str = "Pineview Actual Data Collaboration"
    
    # Database configuration - supports both SQLite (local) and Supabase PostgreSQL (production)
    database_url: str = "sqlite:///./data/pineview.db"
    
    # Debug toggle. When true, diagnostic loggers emit more detail and
    # raw identifiers are allowed through (off by default in prod). Set
    # DEBUG=true in the env for a troubleshooting window.
    debug: bool = False

    # Supabase configuration (for production)
    supabase_url: str = ""
    supabase_anon_key: str = ""
    supabase_service_role_key: str = ""
    supabase_db_url: str = ""  # PostgreSQL connection string from Supabase

    # Optional JWKS URL override. Defaults to
    # ``{supabase_url}/auth/v1/.well-known/jwks.json`` when unset, which
    # matches Supabase's standard asymmetric JWT layout. Only override for
    # self-hosted GoTrue deployments or other non-standard setups.
    supabase_jwt_jwks_url: str = ""

    # API Configuration - explicitly allow Vercel frontend and localhost for development
    allowed_origins: str = "http://localhost:5173,http://127.0.0.1:5173,https://pineview-maps.vercel.app,https://pineviewmaps.com,https://www.pineviewmaps.com,https://pineview-maps.onrender.com"

    # Email configuration. Resend (HTTPS) is preferred because Render
    # throttles/blocks outbound SMTP. SMTP stays as a fallback for local
    # dev or self-hosted deploys where outbound 587 is open.
    resend_api_key: str = ""  # If set, Resend is used and SMTP is ignored
    resend_from_email: str = ""  # e.g. "noreply@pineviewmaps.com" (must be on a verified Resend domain)

    smtp_host: str = "smtp.gmail.com"
    smtp_port: int = 587
    smtp_user: str = ""  # Email address to send from
    smtp_password: str = ""  # App-specific password
    smtp_from_name: str = "Pineview Maps"
    smtp_from_email: str = ""  # Usually same as smtp_user
    
    # Frontend URL for password reset (used in email templates if needed)
    frontend_url: str = "https://pineviewmaps.com"

    # Shared secret embedded in the QR-code worker signup URL.
    # Leave empty to disable self-signup entirely (backend returns 403).
    # Rotate by updating the env var on Render; any printed QR stops working.
    signup_invite_secret: str = ""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    @property
    def origins_list(self) -> list[str]:
        return [origin.strip() for origin in self.allowed_origins.split(",") if origin.strip()]

    @property
    def use_supabase(self) -> bool:
        """Check if Supabase configuration is available"""
        return bool(self.supabase_url and self.supabase_anon_key)


@lru_cache
def get_settings() -> Settings:
    return Settings()