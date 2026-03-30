from pathlib import Path
from typing import Generator

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import get_settings


settings = get_settings()

# Determine which database to use
if settings.supabase_db_url:
    # Production: Use Supabase PostgreSQL directly via psycopg v3
    db_url = settings.supabase_db_url
    # Ensure we use the psycopg v3 driver (not psycopg2)
    if db_url.startswith("postgresql://"):
        db_url = db_url.replace("postgresql://", "postgresql+psycopg://", 1)
    elif db_url.startswith("postgres://"):
        db_url = db_url.replace("postgres://", "postgresql+psycopg://", 1)
    engine = create_engine(
        db_url,
        future=True,
        pool_pre_ping=True,
    )
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
elif settings.database_url.startswith("sqlite"):
    # Development: Use local SQLite
    data_dir = Path(__file__).resolve().parents[1] / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    connect_args = {"check_same_thread": False}
    engine = create_engine(settings.database_url, future=True, connect_args=connect_args)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
else:
    # Fallback: No database connection
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