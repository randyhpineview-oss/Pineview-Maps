from pathlib import Path
from typing import Generator

from sqlalchemy import create_engine, event
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import get_settings


settings = get_settings()

# Handle Supabase PostgreSQL connection vs SQLite
if settings.database_url.startswith("sqlite"):
    # Local SQLite development
    data_dir = Path(__file__).resolve().parents[1] / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    connect_args = {"check_same_thread": False}
    engine_kwargs = {}
else:
    # Supabase PostgreSQL production - use psycopg2 with proper SSL
    connect_args = {
        "sslmode": "require",
        "connect_timeout": 10,
    }
    engine_kwargs = {
        "pool_size": 5,
        "max_overflow": 10,
        "pool_pre_ping": True,  # Test connections before using them
        "pool_recycle": 3600,   # Recycle connections after 1 hour
    }

engine = create_engine(settings.database_url, future=True, connect_args=connect_args, **engine_kwargs)

# Add event listener for connection pool to handle disconnections
@event.listens_for(engine, "connect")
def receive_connect(dbapi_conn, connection_record):
    if not settings.database_url.startswith("sqlite"):
        # Set connection timeout for PostgreSQL
        dbapi_conn.set_isolation_level(0)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)


class Base(DeclarativeBase):
    pass


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()