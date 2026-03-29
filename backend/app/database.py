from pathlib import Path
from typing import Generator

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import get_settings


settings = get_settings()

# For local SQLite development only
if settings.database_url.startswith("sqlite"):
    data_dir = Path(__file__).resolve().parents[1] / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    connect_args = {"check_same_thread": False}
    engine = create_engine(settings.database_url, future=True, connect_args=connect_args)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
else:
    # For production: use Supabase REST API (no direct database connection)
    # This avoids IPv6 network issues on Render
    engine = None
    SessionLocal = None


class Base(DeclarativeBase):
    pass


def get_db() -> Generator[Session, None, None]:
    if SessionLocal is None:
        # Production mode: Supabase REST API (no database session needed)
        yield None
    else:
        # Development mode: SQLite
        db = SessionLocal()
        try:
            yield db
        finally:
            db.close()