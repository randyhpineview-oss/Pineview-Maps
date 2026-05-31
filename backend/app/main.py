import logging
import uuid
from datetime import datetime

from fastapi import Depends, FastAPI, File, HTTPException, Query, Request, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from sqlalchemy import and_, func, inspect, or_, text
from sqlalchemy.orm import Session, defer, joinedload

from app.auth import MANAGES_PINS, get_current_user, require_roles, seed_demo_users
from app.config import get_settings
from app.database import Base, SessionLocal, engine, get_db
from app.kml_import import parse_kml_file
from app.log_util import get_logger
from app.password_reset import router as password_reset_router
from app.rate_limit import limiter
from app.signup import router as signup_router
from app.user_management import router as user_management_router
from app.pipeline_routes import router as pipeline_router
from app.lookup_routes import router as lookup_router
from app.reports_routes import router as reports_router
from app.quote_rates_routes import router as quote_rates_router
from app.quotes_routes import router as quotes_router
from app.quote_drafts_routes import router as quote_drafts_router
from app.calendar_routes import router as calendar_router
from app.devices_routes import (
    read_router as devices_read_router,
    admin_router as devices_admin_router,
    ingest_router as devices_ingest_router,
)
from app.checkin_routes import (
    me_router as checkin_me_router,
    admin_router as checkin_admin_router,
    cron_router as checkin_cron_router,
)
from app.pipeline_models import Pipeline, SprayRecord  # noqa: F401 — ensure tables are registered
from app.calendar_models import (  # noqa: F401 — ensure tables are registered
    CalendarBid,
    CalendarContact,
    CalendarEvent,
    CalendarTask,
)
from app.device_models import Device, DevicePing  # noqa: F401 — ensure tables are registered
from app.checkin_models import (  # noqa: F401 — ensure tables are registered
    Checkin,
    CheckinAlert,
    OfficeAlertRecipient,
    PushSubscription,
    Shift,
    ShiftChange,
    UserProfile,
)
from app.models import (
    ApprovalState,
    PinType,
    Quote,
    QuoteRateCategory,
    QuoteRateItem,
    RoleEnum,
    Site,
    SiteSprayRecord,
    SiteStatus,
    SiteUpdate,
    TimeMaterialsRow,
    TimeMaterialsTicket,
    User,
)
from app.time_materials_routes import (
    append_row_for_spray_record,
    classify_ticket_ownership,
    detach_rows_for_record,
    find_or_create_ticket_for_link,
    router as time_materials_router,
)
from app.hydroseed_routes import router as hydroseed_router
from app.schemas import (
    BulkResetRequest,
    BulkResetResponse,
    ExternalLeaseSheetCreate,
    KmlImportResponse,
    MoveToSiteRequest,
    RecentSubmissionRead,
    RecentSubmissionsDeltaResponse,
    SessionResponse,
    SiteAdminUpdate,
    SiteApprovalUpdate,
    SiteCreate,
    SiteListRead,
    SiteQuickEdit,
    SiteRead,
    SitesDeltaResponse,
    SiteSprayRecordRead,
    SiteSprayRecordSummary,
    SiteSprayRecordCreate,
    SiteSprayRecordUpdate,
    SiteStatusUpdate,
    SprayRecordFilesUpload,
    TypeChangeRequest,
)

settings = get_settings()

# Ensure our ``app.*`` loggers emit at INFO (or DEBUG when settings.debug
# is on). Uvicorn configures its own ``uvicorn.*`` loggers separately and
# we don't touch the root logger, so this doesn't cause double-emission.
logging.getLogger("app").setLevel(
    logging.DEBUG if settings.debug else logging.INFO
)

logger = get_logger(__name__)
app = FastAPI(title=settings.app_name)

# Rate limiter for auth-adjacent endpoints (password reset, signup).
# ``limiter`` is imported from app.rate_limit; attaching it to app.state
# is what enables the ``@limiter.limit(...)`` decorators on individual
# routes. Default exception handler returns 429 with a JSON detail.
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# CORS: restrict to known production domains + localhost dev. The full
# list is configurable via the ALLOWED_ORIGINS env var on Render; the
# ``config.py`` default already covers pineviewmaps.com, its www/vercel
# aliases, and localhost. ``allow_credentials=False`` is correct because
# the frontend sends its Authorization header (Bearer JWT) explicitly,
# not via browser cookies.
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.origins_list,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# GZip compression for large JSON responses (pipelines with coordinates,
# sites list, T&M ticket bundles). Typically shrinks JSON 70-90%, which is
# a direct reduction in Supabase egress for every large API response.
# minimum_size=500 skips tiny responses where gzip overhead outweighs gain.
app.add_middleware(GZipMiddleware, minimum_size=500)

# Include routers AFTER middleware is set up
app.include_router(user_management_router)
app.include_router(password_reset_router)
app.include_router(signup_router)
app.include_router(pipeline_router)
app.include_router(lookup_router)
app.include_router(time_materials_router)
app.include_router(hydroseed_router)
app.include_router(reports_router)
app.include_router(quote_rates_router)
app.include_router(quote_drafts_router)
app.include_router(quotes_router)
app.include_router(calendar_router)
# Three device routers split by audience:
#   - read: GET /api/devices (any logged-in role; powers the map layer)
#   - admin: /api/admin/devices/* (admin only; create/rotate/edit/delete)
#   - ingest: POST /api/devices/ping (bearer-token, NOT JWT; OwnTracks)
app.include_router(devices_read_router)
app.include_router(devices_admin_router)
app.include_router(devices_ingest_router)
# Three check-in routers, audience-separated like devices:
#   - me:    /api/checkins/me/*, /api/shifts/*, /api/checkins, /api/push/* (any role)
#   - admin: /api/admin/checkin-* (admin/office)
#   - cron:  /api/checkins/scan (bearer secret, GitHub Actions)
app.include_router(checkin_me_router)
app.include_router(checkin_admin_router)
app.include_router(checkin_cron_router)


# Global exception handler. Logs the full traceback server-side and
# returns a generic error envelope with a correlation id so operators
# can grep Render logs without leaking implementation details (SQL
# fragments, Dropbox API messages, internal file paths) to the client.
@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    request_id = uuid.uuid4().hex[:12]
    logger.exception(
        "Unhandled exception (request_id=%s method=%s path=%s): %s",
        request_id,
        request.method,
        request.url.path,
        type(exc).__name__,
    )
    # Mirror CORSMiddleware behavior: echo the origin back only when it's
    # in the allow-list so the browser can surface the error body. On
    # non-allowed origins, ship the response without CORS headers — the
    # browser will block it from JS, which is the correct outcome.
    origin = request.headers.get("origin", "")
    headers = {}
    if origin and origin in settings.origins_list:
        headers["Access-Control-Allow-Origin"] = origin
        headers["Vary"] = "Origin"
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error", "request_id": request_id},
        headers=headers,
    )


@app.on_event("startup")
def startup_event() -> None:
    # Only initialize database in development mode (SQLite)
    if engine is not None and settings.database_url.startswith("sqlite"):
        Base.metadata.create_all(bind=engine)
        _migrate_add_columns()
        with SessionLocal() as db:
            seed_demo_users(db)
    # Fix PostgreSQL sequence if needed (for Render deployment)
    elif engine is not None:
        # Create pipeline tables if they don't exist
        try:
            Base.metadata.create_all(bind=engine, tables=[Pipeline.__table__, SprayRecord.__table__, SiteSprayRecord.__table__], checkfirst=True)
            print("[STARTUP] Pipeline and SiteSprayRecord tables ensured")
        except Exception as e:
            print(f"Warning: Could not create pipeline tables: {e}")
        # Create calendar tables if they don't exist. The full migration
        # (indexes, REPLICA IDENTITY, supabase_realtime publication) lives in
        # database/calendar_setup.sql; this fallback covers the case where the
        # API ships before that SQL is run, so basic CRUD still works (just
        # without Realtime push until the SQL migration is applied).
        try:
            Base.metadata.create_all(
                bind=engine,
                tables=[
                    CalendarTask.__table__,
                    CalendarContact.__table__,
                    CalendarEvent.__table__,
                    CalendarBid.__table__,
                ],
                checkfirst=True,
            )
            print("[STARTUP] Calendar tables ensured")
        except Exception as e:
            print(f"Warning: Could not create calendar tables: {e}")
        # Create devices tables if they don't exist. The full migration
        # (indexes, REPLICA IDENTITY, supabase_realtime publication) lives in
        # database/devices_setup.sql; this fallback covers the case where the
        # API ships before that SQL is run, so basic CRUD still works (just
        # without Realtime push until the SQL migration is applied).
        try:
            Base.metadata.create_all(
                bind=engine,
                tables=[
                    Device.__table__,
                    DevicePing.__table__,
                ],
                checkfirst=True,
            )
            print("[STARTUP] Devices tables ensured")
        except Exception as e:
            print(f"Warning: Could not create devices tables: {e}")
        # Create check-in tables if they don't exist. The full migration
        # (REPLICA IDENTITY, supabase_realtime publication, partial unique
        # index on office_alert_recipients.is_primary) lives in
        # database/checkins_setup.sql; this fallback covers the case where
        # the API ships before that SQL is run, so basic CRUD still works
        # (just without Realtime push or DB-level primary uniqueness).
        try:
            Base.metadata.create_all(
                bind=engine,
                tables=[
                    UserProfile.__table__,
                    Shift.__table__,
                    Checkin.__table__,
                    ShiftChange.__table__,
                    PushSubscription.__table__,
                    CheckinAlert.__table__,
                    OfficeAlertRecipient.__table__,
                ],
                checkfirst=True,
            )
            print("[STARTUP] Check-in tables ensured")
        except Exception as e:
            print(f"Warning: Could not create check-in tables: {e}")
        # Run column migrations on Postgres too
        try:
            _migrate_add_columns()
        except Exception as e:
            print(f"Warning: Column migration failed: {e}")
        try:
            with engine.begin() as conn:
                # Get the actual sequence name for the sites.id column
                seq_result = conn.execute(text("""
                    SELECT pg_get_serial_sequence('sites', 'id')
                """)).scalar()
                if seq_result:
                    # Reset the sequence to MAX(id) + 1
                    conn.execute(text(f"""
                        SELECT setval('{seq_result}', COALESCE((SELECT MAX(id) FROM sites), 0) + 1, false)
                    """))
        except Exception as e:
            # Log error but don't crash startup
            print(f"Warning: Could not reset sites_id_seq: {e}")


# Schema migration version. BUMP THIS WHENEVER YOU CHANGE THE BODY OF
# `_migrate_add_columns()` — adding a new column, a new index, an ALTER
# TYPE, anything. Forgetting to bump means existing databases skip the
# new migration on subsequent boots; it'll still run correctly on a
# fresh DB because the schema_meta SELECT returns NULL there.
#
# Format: an opaque-but-meaningful string. Date-prefix + initial keeps
# bumps obvious in git blame. The exact value doesn't matter as long as
# it differs from any prior committed value.
_MIGRATION_VERSION = "2026-05-25-requester-name-scalars"


def _migrate_add_columns() -> None:
    """Add columns that create_all() won't add to existing tables.

    Short-circuits when ``schema_meta.migration_version`` already
    matches ``_MIGRATION_VERSION`` so cold starts on Render don't pay
    the ~200 ms of inspect() reflection + redundant CREATE INDEX
    round-trips on every container wake. Idempotent on first run
    against any DB (fresh or already-migrated).
    """
    if engine is None:
        return

    is_sqlite = str(engine.url).startswith("sqlite")

    # ── Short-circuit: skip the body if this DB is already on the
    # current MIGRATION_VERSION. The schema_meta table itself is
    # idempotently created here so the very first run after this
    # function ships works on existing prod DBs without a manual step.
    with engine.begin() as conn:
        conn.execute(text(
            "CREATE TABLE IF NOT EXISTS schema_meta ("
            " key TEXT PRIMARY KEY,"
            " value TEXT NOT NULL"
            ")"
        ))
        current = conn.execute(text(
            "SELECT value FROM schema_meta WHERE key = 'migration_version'"
        )).scalar()
    if current == _MIGRATION_VERSION:
        return

    insp = inspect(engine)
    with engine.begin() as conn:
        if not is_sqlite:
            try:
                conn.execute(text("ALTER TYPE sitestatus ADD VALUE IF NOT EXISTS 'in_progress'"))
                conn.execute(text("ALTER TYPE sitestatus ADD VALUE IF NOT EXISTS 'issue_not_inspected'"))
            except Exception as e:
                print(f"Warning: sitestatus enum migration failed: {e}")

        # Sites migrations
        if insp.has_table("sites"):
            existing_sites = {col["name"] for col in insp.get_columns("sites")}
            if "deleted_at" not in existing_sites:
                conn.execute(text("ALTER TABLE sites ADD COLUMN deleted_at TIMESTAMP"))
            if "deleted_by_user_id" not in existing_sites:
                if is_sqlite:
                    conn.execute(text("ALTER TABLE sites ADD COLUMN deleted_by_user_id INTEGER"))
                else:
                    conn.execute(text("ALTER TABLE sites ADD COLUMN deleted_by_user_id INTEGER REFERENCES users(id)"))
            if "is_hidden" not in existing_sites:
                if is_sqlite:
                    conn.execute(text("ALTER TABLE sites ADD COLUMN is_hidden BOOLEAN NOT NULL DEFAULT 0"))
                else:
                    conn.execute(text("ALTER TABLE sites ADD COLUMN is_hidden BOOLEAN NOT NULL DEFAULT false"))
                    conn.execute(text("CREATE INDEX IF NOT EXISTS idx_sites_is_hidden ON sites(is_hidden)"))
            # Track who requested a pending change (currently used by the
            # request-type-change endpoint so admins can see who asked for
            # the swap in the Pending Approvals list).
            if "pending_change_requested_by_user_id" not in existing_sites:
                if is_sqlite:
                    conn.execute(text("ALTER TABLE sites ADD COLUMN pending_change_requested_by_user_id INTEGER"))
                else:
                    conn.execute(text(
                        "ALTER TABLE sites ADD COLUMN pending_change_requested_by_user_id INTEGER REFERENCES users(id)"
                    ))
                    conn.execute(text(
                        "CREATE INDEX IF NOT EXISTS idx_sites_pending_change_requested_by_user_id "
                        "ON sites(pending_change_requested_by_user_id)"
                    ))
            # Denormalized requester-name scalars. Required for the admin's
            # pending-approvals card to show a name on rows that arrive via
            # Supabase Realtime (raw row, no JOINs). Mirrors the existing
            # last_inspected_by_name pattern. Backfilled from users.name
            # for any pre-existing rows so old pending pins also display.
            if "created_by_name" not in existing_sites:
                conn.execute(text("ALTER TABLE sites ADD COLUMN created_by_name VARCHAR(255)"))
                # Backfill from users.name. SQLite supports this UPDATE...FROM
                # syntax from 3.33+; Postgres has it natively.
                try:
                    conn.execute(text(
                        "UPDATE sites SET created_by_name = users.name "
                        "FROM users "
                        "WHERE sites.created_by_user_id = users.id "
                        "AND sites.created_by_name IS NULL"
                    ))
                except Exception as e:
                    print(f"[MIGRATE] created_by_name backfill skipped (non-fatal): {e}")
            if "pending_change_requested_by_name" not in existing_sites:
                conn.execute(text("ALTER TABLE sites ADD COLUMN pending_change_requested_by_name VARCHAR(255)"))
                try:
                    conn.execute(text(
                        "UPDATE sites SET pending_change_requested_by_name = users.name "
                        "FROM users "
                        "WHERE sites.pending_change_requested_by_user_id = users.id "
                        "AND sites.pending_change_requested_by_name IS NULL"
                    ))
                except Exception as e:
                    print(f"[MIGRATE] pending_change_requested_by_name backfill skipped (non-fatal): {e}")
                    
        # Pipelines migrations
        if insp.has_table("pipelines"):
            existing_pipelines = {col["name"] for col in insp.get_columns("pipelines")}
            if "deleted_by_user_id" not in existing_pipelines:
                if is_sqlite:
                    conn.execute(text("ALTER TABLE pipelines ADD COLUMN deleted_by_user_id INTEGER"))
                else:
                    conn.execute(text("ALTER TABLE pipelines ADD COLUMN deleted_by_user_id INTEGER REFERENCES users(id)"))
                    
        # SiteSprayRecords table creation (since create_all might not catch it if added late)
        if not insp.has_table("site_spray_records"):
            # We let create_all handle it at startup, but just in case:
            pass
        
        # Ensure Time & Materials tables exist (not included in default create_all on first deploys)
        try:
            Base.metadata.create_all(
                bind=engine,
                tables=[TimeMaterialsTicket.__table__, TimeMaterialsRow.__table__],
                checkfirst=True,
            )
        except Exception as e:
            print(f"[STARTUP] Could not ensure T&M tables: {e}")

        # Ensure Quote Builder tables exist. The quote_seq sequence is
        # created separately by quote_builder_migration.sql — on a fresh
        # Postgres install create_all() doesn't make the bare sequence so
        # we also issue an idempotent CREATE SEQUENCE here. (SQLAlchemy
        # autogenerates per-column SERIAL sequences for the id PKs, but
        # `quote_seq` is a standalone sequence used by the submit handler
        # to allocate Q###### numbers.)
        try:
            Base.metadata.create_all(
                bind=engine,
                tables=[
                    QuoteRateCategory.__table__,
                    QuoteRateItem.__table__,
                    Quote.__table__,
                ],
                checkfirst=True,
            )
            if not is_sqlite:
                conn.execute(text(
                    "CREATE SEQUENCE IF NOT EXISTS quote_seq "
                    "START WITH 1 INCREMENT BY 1 MINVALUE 1 NO CYCLE"
                ))
        except Exception as e:
            print(f"[STARTUP] Could not ensure Quote Builder tables: {e}")

        # Add `deleted_at` to time_materials_tickets on upgrade. Required by
        # the /api/time-materials/delta endpoint to ship removed IDs to
        # the frontend cache via `ids_removed`.
        if insp.has_table("time_materials_tickets"):
            existing_tm = {col["name"] for col in insp.get_columns("time_materials_tickets")}
            if "deleted_at" not in existing_tm:
                conn.execute(text("ALTER TABLE time_materials_tickets ADD COLUMN deleted_at TIMESTAMP"))
                # Index matches the ORM `index=True` on the column so the
                # delta query's `deleted_at IS (NOT) NULL` filters stay cheap.
                try:
                    conn.execute(text(
                        "CREATE INDEX IF NOT EXISTS ix_time_materials_tickets_deleted_at "
                        "ON time_materials_tickets(deleted_at)"
                    ))
                except Exception as e:
                    print(f"[STARTUP] Could not create tm_tickets.deleted_at index: {e}")

        # site_spray_records migrations
        if insp.has_table("site_spray_records"):
            existing_site_records = {col["name"] for col in insp.get_columns("site_spray_records")}
            if "ticket_number" not in existing_site_records:
                conn.execute(text("ALTER TABLE site_spray_records ADD COLUMN ticket_number VARCHAR(50)"))
            if "lease_sheet_data" not in existing_site_records:
                conn.execute(text("ALTER TABLE site_spray_records ADD COLUMN lease_sheet_data JSONB"))
            if "pdf_url" not in existing_site_records:
                conn.execute(text("ALTER TABLE site_spray_records ADD COLUMN pdf_url TEXT"))
            if "tm_ticket_id" not in existing_site_records:
                if is_sqlite:
                    conn.execute(text("ALTER TABLE site_spray_records ADD COLUMN tm_ticket_id INTEGER"))
                else:
                    conn.execute(text(
                        "ALTER TABLE site_spray_records ADD COLUMN tm_ticket_id INTEGER "
                        "REFERENCES time_materials_tickets(id) ON DELETE SET NULL"
                    ))
            if "photo_urls" not in existing_site_records:
                if is_sqlite:
                    conn.execute(text("ALTER TABLE site_spray_records ADD COLUMN photo_urls TEXT DEFAULT '[]'"))
                else:
                    conn.execute(text("ALTER TABLE site_spray_records ADD COLUMN photo_urls JSONB DEFAULT '[]'"))
            elif not is_sqlite:
                # Fix: convert text[] to JSONB if needed
                for col in insp.get_columns("site_spray_records"):
                    if col["name"] == "photo_urls" and "ARRAY" in str(col.get("type", "")):
                        conn.execute(text(
                            "ALTER TABLE site_spray_records ALTER COLUMN photo_urls TYPE JSONB "
                            "USING COALESCE(to_jsonb(photo_urls), '[]'::jsonb)"
                        ))
                        break
            # Offline-submission idempotency key. Frontend mints a UUID per
            # queued submission; backend dedupes against this column on the
            # create endpoint so retries (after a network drop *between*
            # server-commit and client-ack) don't burn a 2nd ticket number.
            if "client_submission_id" not in existing_site_records:
                conn.execute(text("ALTER TABLE site_spray_records ADD COLUMN client_submission_id VARCHAR(64)"))
            # Partial unique index — null IDs aren't constrained (legacy rows
            # and any non-offline-path inserts that skip the key). Postgres
            # supports `WHERE`; SQLite (used in dev) doesn't enforce partial
            # uniqueness the same way but the explicit dedupe SELECT in the
            # endpoint guards both.
            #
            # NOTE: We deliberately don't call `insp.get_indexes(...)` here.
            # On Render's hosted Postgres, the pg_catalog reflection query
            # SQLAlchemy emits is heavy enough to hit the database's
            # statement_timeout during boot — that's what blew up the
            # 71bdf67 deploy. `CREATE … IF NOT EXISTS` is natively
            # idempotent, so the membership check was redundant anyway.
            try:
                conn.execute(text(
                    "CREATE UNIQUE INDEX IF NOT EXISTS uq_site_spray_records_client_submission_id "
                    "ON site_spray_records(client_submission_id) "
                    "WHERE client_submission_id IS NOT NULL"
                ))
            except Exception as e:
                # Don't block startup on a non-critical index creation —
                # the explicit dedupe SELECT in create_site_spray_record
                # still enforces uniqueness functionally.
                print(f"Warning: uq_site_spray_records_client_submission_id index creation failed: {e}")

            # One-shot cleanup of the redundant `ix_site_spray_records_
            # client_submission_id` index that earlier deploys auto-created
            # via the SQLAlchemy `index=True` flag on the column. The
            # partial unique index above covers every equality lookup we
            # do, so the plain index is dead weight on writes. `DROP INDEX
            # IF EXISTS` is idempotent — a no-op on subsequent cold starts.
            try:
                conn.execute(text(
                    "DROP INDEX IF EXISTS ix_site_spray_records_client_submission_id"
                ))
            except Exception as e:
                print(f"Warning: ix_site_spray_records_client_submission_id index drop failed: {e}")

        if insp.has_table("spray_records"):
            existing_records = {col["name"] for col in insp.get_columns("spray_records")}
            if "is_avoided" not in existing_records:
                if is_sqlite:
                    conn.execute(text("ALTER TABLE spray_records ADD COLUMN is_avoided BOOLEAN NOT NULL DEFAULT 0"))
                else:
                    conn.execute(text("ALTER TABLE spray_records ADD COLUMN is_avoided BOOLEAN NOT NULL DEFAULT FALSE"))
            
            # Lease sheet fields migration
            if "ticket_number" not in existing_records:
                conn.execute(text("ALTER TABLE spray_records ADD COLUMN ticket_number VARCHAR(20)"))
            if "lease_sheet_data" not in existing_records:
                conn.execute(text("ALTER TABLE spray_records ADD COLUMN lease_sheet_data JSONB"))
            if "pdf_url" not in existing_records:
                conn.execute(text("ALTER TABLE spray_records ADD COLUMN pdf_url TEXT"))
            if "photo_urls" not in existing_records:
                if is_sqlite:
                    conn.execute(text("ALTER TABLE spray_records ADD COLUMN photo_urls TEXT DEFAULT '[]'"))
                else:
                    conn.execute(text("ALTER TABLE spray_records ADD COLUMN photo_urls JSONB DEFAULT '[]'"))
            elif not is_sqlite:
                # Fix: convert text[] to JSONB if needed
                for col in insp.get_columns("spray_records"):
                    if col["name"] == "photo_urls" and "ARRAY" in str(col.get("type", "")):
                        conn.execute(text(
                            "ALTER TABLE spray_records ALTER COLUMN photo_urls TYPE JSONB "
                            "USING COALESCE(to_jsonb(photo_urls), '[]'::jsonb)"
                        ))
                        break
            
            # Create index for ticket_number if it doesn't exist.
            # Same rationale as above for skipping insp.get_indexes() —
            # `IF NOT EXISTS` makes the membership check unnecessary and
            # avoids the pg_catalog reflection that timed out on Render.
            try:
                conn.execute(text(
                    "CREATE INDEX IF NOT EXISTS idx_spray_records_ticket_number "
                    "ON spray_records(ticket_number)"
                ))
            except Exception as e:
                print(f"Warning: idx_spray_records_ticket_number index creation failed: {e}")

            # Idempotency key for offline-queued pipeline lease sheets — see
            # the matching block in site_spray_records above.
            if "client_submission_id" not in existing_records:
                conn.execute(text("ALTER TABLE spray_records ADD COLUMN client_submission_id VARCHAR(64)"))
            try:
                conn.execute(text(
                    "CREATE UNIQUE INDEX IF NOT EXISTS uq_spray_records_client_submission_id "
                    "ON spray_records(client_submission_id) "
                    "WHERE client_submission_id IS NOT NULL"
                ))
            except Exception as e:
                print(f"Warning: uq_spray_records_client_submission_id index creation failed: {e}")

            # Mirror of the site_spray_records cleanup above — drop the
            # redundant `ix_spray_records_client_submission_id` plain index
            # left over from earlier deploys that used `index=True` on the
            # column. The partial unique index handles every lookup.
            try:
                conn.execute(text(
                    "DROP INDEX IF EXISTS ix_spray_records_client_submission_id"
                ))
            except Exception as e:
                print(f"Warning: ix_spray_records_client_submission_id index drop failed: {e}")

    # ── Stamp schema_meta so subsequent cold starts can short-circuit.
    # Done in its own transaction so the migrations above commit even if
    # this UPSERT trips. Postgres + SQLite (3.24+) both support
    # `ON CONFLICT(key) DO UPDATE`. We branch the SQL only because
    # SQLite's parameter substitution differs slightly across drivers
    # we've used in the past — keeping it explicit is safer than
    # debugging a binding edge case at startup.
    try:
        with engine.begin() as conn:
            if is_sqlite:
                conn.execute(
                    text(
                        "INSERT INTO schema_meta(key, value) VALUES('migration_version', :v) "
                        "ON CONFLICT(key) DO UPDATE SET value = :v"
                    ),
                    {"v": _MIGRATION_VERSION},
                )
            else:
                conn.execute(
                    text(
                        "INSERT INTO schema_meta(key, value) VALUES('migration_version', :v) "
                        "ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value"
                    ),
                    {"v": _MIGRATION_VERSION},
                )
    except Exception as e:
        # Non-fatal: the next cold start will just re-run the migrations
        # (which are all idempotent). Logging is enough.
        print(f"Warning: schema_meta version stamp failed: {e}")


def get_site_or_404(db: Session, site_id: int) -> Site:
    site = (
        db.query(Site)
        .options(
            joinedload(Site.updates),
            joinedload(Site.spray_records),
        )
        .filter(Site.id == site_id)
        .first()
    )
    if site is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Site not found")
    # Filter out soft-deleted spray records in Python so we don't need a
    # custom primaryjoin condition on the relationship. This is safe because
    # get_site_or_404 is only called from single-site detail endpoints where
    # the full record set is always small (< a few dozen rows per site).
    site.spray_records = [r for r in (site.spray_records or []) if r.deleted_at is None]
    return site


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.api_route("/health", methods=["GET", "HEAD"])
def health_check() -> dict[str, str]:
    return {
        "status": "healthy",
        "timestamp": datetime.utcnow().isoformat(),
        "service": "pineview-backend"
    }


@app.get("/api/session", response_model=SessionResponse)
def session(current_user: User = Depends(get_current_user)) -> SessionResponse:
    return SessionResponse(user=current_user)


@app.get("/api/next-ticket")
def next_ticket(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get the next herbicide-lease-sheet ticket number from herb_lease_seq.

    Used by the lease-sheet form to show an "HL######" preview before submit.
    T&M tickets have their own endpoint/allocator on tm_ticket_seq (TM prefix).
    """
    result = db.execute(text("SELECT nextval('herb_lease_seq')"))
    seq_value = result.scalar()
    return {"ticket_number": f"HL{seq_value:06d}"}


@app.get("/api/sync-status")
def sync_status(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """Return lightweight sync status to reduce bandwidth usage."""
    # MAX without filtering deleted rows — a soft-delete ALSO bumps updated_at,
    # and the delta endpoints return soft-deleted IDs in `ids_removed` so the
    # frontend can prune its cache. If we filtered `deleted_at IS NULL` here
    # and the deleted row was the freshest, clients would never be told to
    # refresh and the pin would stay on their map forever.
    sites_updated = db.execute(text("SELECT MAX(updated_at) FROM sites")).scalar()
    pipelines_updated = db.execute(text("SELECT MAX(updated_at) FROM pipelines")).scalar()
    spray_records_updated = db.execute(text(
        "SELECT MAX(ts) FROM ("
        "  SELECT MAX(updated_at) AS ts FROM site_spray_records"
        "  UNION ALL"
        "  SELECT MAX(updated_at) AS ts FROM spray_records"
        ") t"
    )).scalar()
    # Cheap watermark for T&M tickets so the frontend can detect "something
    # changed" without re-downloading the full list every poll tick. Matches
    # the sites/pipelines pattern above — single MAX on an indexed column.
    tm_tickets_updated = db.execute(text("SELECT MAX(updated_at) FROM time_materials_tickets")).scalar()
    # Hydroseed module watermarks (cheap MAX on indexed updated_at). Defaults
    # to None when the migration hasn't been applied yet — frontend treats
    # null as "never changed" and skips the delta call.
    try:
        hydroseed_dailies_updated = db.execute(
            text("SELECT MAX(updated_at) FROM hydroseed_daily_records")
        ).scalar()
        hydroseed_tickets_updated = db.execute(
            text("SELECT MAX(updated_at) FROM hydroseed_tickets")
        ).scalar()
    except Exception:
        hydroseed_dailies_updated = None
        hydroseed_tickets_updated = None

    # Get pending counts for admins
    pending_sites_count = 0
    pending_pipelines_count = 0
    if current_user.role in MANAGES_PINS:
        pending_sites_count = db.query(Site).filter(
            Site.approval_state == ApprovalState.pending_review,
            Site.deleted_at.is_(None),
            Site.is_hidden.is_(False),
        ).count()
        # Import pipeline model for count
        from app.pipeline_models import Pipeline as PipelineModel
        pending_pipelines_count = db.query(PipelineModel).filter(
            PipelineModel.approval_state == "pending_review",
            PipelineModel.deleted_at.is_(None)
        ).count()

    return {
        "sites_last_updated": sites_updated.isoformat() if sites_updated else None,
        "pipelines_last_updated": pipelines_updated.isoformat() if pipelines_updated else None,
        "spray_records_last_updated": spray_records_updated.isoformat() if spray_records_updated else None,
        "tm_tickets_last_updated": tm_tickets_updated.isoformat() if tm_tickets_updated else None,
        "hydroseed_dailies_last_updated": hydroseed_dailies_updated.isoformat() if hydroseed_dailies_updated else None,
        "hydroseed_tickets_last_updated": hydroseed_tickets_updated.isoformat() if hydroseed_tickets_updated else None,
        "pending_sites_count": pending_sites_count,
        "pending_pipelines_count": pending_pipelines_count,
    }


def _build_site_list_items(sites: list[Site], has_spray_map: dict[int, bool]) -> list[SiteListRead]:
    """Turn ORM Site rows into SiteListRead DTOs, attaching `has_spray_records`.

    Keeps the slim-list path free of nested loads — callers compute
    `has_spray_map` in a single lightweight `EXISTS`-style query instead of
    joinedload-ing the full spray_records collection.
    """
    out: list[SiteListRead] = []
    for s in sites:
        dto = SiteListRead.model_validate(s)
        dto.has_spray_records = bool(has_spray_map.get(s.id, False))
        out.append(dto)
    return out


def _has_spray_map_for(db: Session, site_ids: list[int]) -> dict[int, bool]:
    """Return {site_id: True} for every site that has at least one spray record.

    Single GROUP-BY query, so cost is O(1) round-trip regardless of how many
    sites are in the list. Skipping this when `site_ids` is empty avoids an
    unnecessary DB hit on empty deltas.
    """
    if not site_ids:
        return {}
    rows = (
        db.query(SiteSprayRecord.site_id)
        .filter(SiteSprayRecord.site_id.in_(site_ids))
        .distinct()
        .all()
    )
    return {row[0]: True for row in rows}


@app.get("/api/sites", response_model=list[SiteListRead])
def list_sites(
    search: str | None = Query(default=None),
    client: str | None = Query(default=None),
    area: str | None = Query(default=None),
    approval_state: ApprovalState | None = Query(default=None),
    pin_type: PinType | None = Query(default=None),
    site_status: SiteStatus | None = Query(default=None, alias="status"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[SiteListRead]:
    """Map / list / filter panel view of sites.

    EGRESS: returns the slim `SiteListRead` schema — no `updates`,
    `spray_records`, `raw_attributes`, or nested user relations. For any of
    those, the detail view calls `GET /api/sites/{id}`, which returns the
    full `SiteRead`. This is the single biggest egress saver on the pooler.
    """
    query = (
        db.query(Site)
        .filter(Site.deleted_at.is_(None), Site.is_hidden.is_(False))
        .order_by(Site.updated_at.desc())
    )

    if client:
        query = query.filter(Site.client == client)
    if area:
        query = query.filter(Site.area == area)
    if approval_state:
        query = query.filter(Site.approval_state == approval_state)
    else:
        query = query.filter(Site.approval_state != ApprovalState.rejected)
    if pin_type:
        query = query.filter(Site.pin_type == pin_type)
    if site_status:
        query = query.filter(Site.status == site_status)
    if search:
        like_value = f"%{search.strip()}%"
        query = query.filter(
            or_(
                Site.lsd.ilike(like_value),
                Site.client.ilike(like_value),
                Site.area.ilike(like_value),
                Site.notes.ilike(like_value),
            )
        )

    sites = query.all()
    has_spray_map = _has_spray_map_for(db, [s.id for s in sites])
    return _build_site_list_items(sites, has_spray_map)


# NOTE: /api/sites/delta MUST be declared before /api/sites/{site_id},
# otherwise FastAPI routes "delta" as a site_id path parameter.
@app.get("/api/sites/delta", response_model=SitesDeltaResponse)
def sites_delta(
    since: datetime = Query(..., description="ISO timestamp from a previous server_time"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> SitesDeltaResponse:
    """Incremental sites sync — only rows whose `updated_at > since`.

    Huge egress win vs. refetching the whole list on every poll tick:
    a typical tick transfers 0-3 rows instead of hundreds. The frontend
    merges `items` into its cache and drops `ids_removed` from it.

    `server_time` is what the caller should send back as `?since=` next time.

    EGRESS: same slim `SiteListRead` schema as /api/sites — no heavy
    relations shipped per delta tick.
    """
    # Capture server_time FIRST so any row written during this request is
    # guaranteed to be caught by the next `?since=server_time` call.
    server_time = datetime.utcnow()

    # Active rows updated since the caller's watermark.
    items_q = (
        db.query(Site)
        .filter(
            Site.updated_at > since,
            Site.deleted_at.is_(None),
            Site.approval_state != ApprovalState.rejected,
            Site.is_hidden.is_(False),
        )
    )
    sites = items_q.all()
    has_spray_map = _has_spray_map_for(db, [s.id for s in sites])
    items = _build_site_list_items(sites, has_spray_map)

    # Rows that became invisible since the caller's watermark: soft-deleted
    # OR rejected. Frontend drops these IDs from its local cache/map.
    removed_q = (
        db.query(Site.id)
        .filter(
            Site.updated_at > since,
            or_(
                Site.deleted_at.isnot(None),
                Site.approval_state == ApprovalState.rejected,
            ),
        )
    )
    ids_removed = [row[0] for row in removed_q.all()]

    return SitesDeltaResponse(
        items=items,
        ids_removed=ids_removed,
        server_time=server_time,
    )


@app.get("/api/sites/{site_id}", response_model=SiteRead)
def get_site(
    site_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> SiteRead:
    site = get_site_or_404(db, site_id)
    if site.deleted_at is not None or site.approval_state == ApprovalState.rejected:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Site not found")
    return SiteRead.model_validate(site)


@app.get(
    "/api/pending-sites",
    response_model=list[SiteRead],
    dependencies=[Depends(require_roles(*MANAGES_PINS))],
)
def pending_sites(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[SiteRead]:
    sites = (
        db.query(Site)
        .options(
            joinedload(Site.updates),
            joinedload(Site.created_by_user),
            joinedload(Site.pending_change_requested_by_user),
        )
        .filter(Site.approval_state == ApprovalState.pending_review)
        .filter(Site.deleted_at.is_(None))
        .order_by(Site.created_at.desc())
        .all()
    )
    return [SiteRead.model_validate(site) for site in sites]


@app.post("/api/sites", response_model=SiteRead, status_code=status.HTTP_201_CREATED)
def create_site(
    payload: SiteCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> SiteRead:
    # Idempotency for offline-queued pin creation. We don't have a dedicated
    # column on `sites`, so the key is stamped into raw_attributes JSONB
    # under "_client_submission_id". Lookup is a single jsonb_extract_path
    # match — cheap, no migration. If the same key is already in the DB,
    # return that pin instead of inserting a duplicate. Wrapped in try/except
    # because SQLite dialects older than 3.38 don't support the `->>`
    # operator; production (Postgres) has full JSONB support.
    if payload.client_submission_id:
        try:
            existing = (
                db.query(Site)
                .filter(
                    Site.deleted_at.is_(None),
                    Site.raw_attributes.op("->>")("_client_submission_id") == payload.client_submission_id,
                )
                .first()
            )
            if existing is not None:
                return SiteRead.model_validate(existing)
        except Exception as e:
            # Non-fatal: fall through to insert. A duplicate from a stuck
            # retry is much rarer for pins than for spray records (no
            # ticket number to burn), so dev SQLite skipping the dedupe
            # is an acceptable degradation.
            print(f"[CREATE_SITE] dedupe lookup failed (non-fatal): {e}")

    created_at = datetime.utcnow()
    raw_attrs = {"_client_submission_id": payload.client_submission_id} if payload.client_submission_id else None
    site = Site(
        pin_type=payload.pin_type,
        lsd=payload.lsd,
        client=payload.client,
        area=payload.area,
        latitude=payload.latitude,
        longitude=payload.longitude,
        gate_code=payload.gate_code,
        phone_number=payload.phone_number,
        notes=payload.notes,
        source="field_added",
        approval_state=ApprovalState.pending_review,
        status=payload.status,
        last_inspected_at=created_at if payload.status in (SiteStatus.inspected, SiteStatus.in_progress) else None,
        raw_attributes=raw_attrs,
    )
    
    # Only set created_by_user_id if user exists in local DB to avoid FK constraint
    if current_user.id:
        local_user = db.query(User).filter(User.id == current_user.id).first()
        if local_user:
            site.created_by_user_id = current_user.id
    # Always stamp the requester name as a denormalized scalar — it's the
    # only channel by which the admin's pending-approvals card sees the
    # name when the row arrives via Supabase Realtime (raw row, no JOINs).
    # We pull from current_user.name (which the auth layer hydrates from
    # either the local users row or the JWT user_metadata), so this works
    # even when the FK guard above bails (e.g. transient user fallback).
    site.created_by_name = (current_user.name or current_user.email or None)
    
    db.add(site)
    db.flush()
    db.add(
        SiteUpdate(
            site_id=site.id,
            status=payload.status,
            note="Initial submission",
            sync_status="synced",
            created_at=created_at,
        )
    )
    db.commit()
    db.refresh(site)
    return SiteRead.model_validate(site)


@app.patch(
    "/api/sites/{site_id}",
    response_model=SiteRead,
    dependencies=[Depends(require_roles(*MANAGES_PINS))],
)
def update_site(
    site_id: int,
    payload: SiteAdminUpdate,
    db: Session = Depends(get_db),
) -> SiteRead:
    site = get_site_or_404(db, site_id)
    changes = payload.model_dump(exclude_unset=True)
    for field_name, value in changes.items():
        setattr(site, field_name, value)

    site.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(site)
    return SiteRead.model_validate(site)


@app.patch("/api/sites/{site_id}/quick-edit", response_model=SiteRead)
def quick_edit_site(
    site_id: int,
    payload: SiteQuickEdit,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> SiteRead:
    site = get_site_or_404(db, site_id)
    changes = payload.model_dump(exclude_unset=True)
    for field_name, value in changes.items():
        setattr(site, field_name, value)
    site.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(site)
    return SiteRead.model_validate(site)


def _strip_photos_from_lease_data(data: dict | None) -> dict | None:
    """Return a copy of lease_sheet_data with photos[].data stripped.

    The base64 image bytes bloat the DB (and every list endpoint response). The
    photos are already uploaded to Dropbox and their URLs live in photo_urls,
    so we keep only lightweight metadata (name, type, etc.) in the JSONB copy.
    """
    if not data:
        return data
    out = dict(data)
    if isinstance(out.get("photos"), list):
        out["photos"] = [
            {k: v for k, v in p.items() if k != "data"}
            for p in out["photos"]
            if isinstance(p, dict)
        ]
    return out


def _site_status_from_spray_payload(payload: SiteSprayRecordCreate) -> SiteStatus:
    if payload.is_avoided:
        return SiteStatus.issue
    nested_status = None
    if isinstance(payload.lease_sheet_data, dict):
        nested_status = payload.lease_sheet_data.get("site_status")
    if payload.site_status == SiteStatus.issue_not_inspected or nested_status == SiteStatus.issue_not_inspected.value:
        return SiteStatus.issue_not_inspected
    if payload.site_status == SiteStatus.in_progress or nested_status == SiteStatus.in_progress.value:
        return SiteStatus.in_progress
    return SiteStatus.inspected


@app.get("/api/sites/{site_id}/spray", response_model=list[SiteSprayRecordSummary])
def list_site_spray_records(
    site_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List spray records for a site (summary — no lease_sheet_data).

    defer() skips the heavy JSONB column at the DB query level so it never
    leaves Supabase. The detail endpoint /api/site-spray-records/{id} fetches
    the full row when the edit flow actually needs it.
    """
    get_site_or_404(db, site_id)
    q = (
        db.query(SiteSprayRecord)
        .options(defer(SiteSprayRecord.lease_sheet_data))
        .filter(
            SiteSprayRecord.site_id == site_id,
            SiteSprayRecord.deleted_at.is_(None),
        )
    )
    return [SiteSprayRecordSummary.model_validate(r) for r in q.order_by(SiteSprayRecord.created_at.desc()).all()]


@app.get("/api/site-spray-records/{record_id}", response_model=SiteSprayRecordRead)
def get_site_spray_record(
    record_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Full spray record (including lease_sheet_data) — used by the edit flow."""
    record = db.query(SiteSprayRecord).filter(SiteSprayRecord.id == record_id).first()
    if not record:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Site spray record not found")
    return SiteSprayRecordRead.model_validate(record)


@app.post("/api/sites/{site_id}/spray", response_model=SiteSprayRecordRead)
def create_site_spray_record(
    site_id: int,
    payload: SiteSprayRecordCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Create a new spray record for a site."""
    import base64
    from app.dropbox_integration import upload_files_parallel, build_pdf_path, build_photo_path

    site = get_site_or_404(db, site_id)

    # Idempotency: if the frontend retried an offline-queued submission and
    # we already committed the record, return the existing one instead of
    # inserting a second row + burning another HL ticket from the sequence.
    # `client_submission_id` is a UUID minted on the frontend before
    # queueing; the partial unique index on the column also enforces this
    # at the DB level as a backstop.
    if payload.client_submission_id:
        existing = (
            db.query(SiteSprayRecord)
            .filter(
                SiteSprayRecord.site_id == site_id,
                SiteSprayRecord.client_submission_id == payload.client_submission_id,
                SiteSprayRecord.deleted_at.is_(None),
            )
            .first()
        )
        if existing is not None:
            site_status = _site_status_from_spray_payload(payload)
            if site_status == SiteStatus.in_progress and site.status == SiteStatus.inspected:
                site.status = SiteStatus.in_progress
                site.updated_at = datetime.utcnow()
                db.commit()
            return SiteSprayRecordRead.model_validate(existing)

    user_id = None
    if current_user.id:
        local_user = db.query(User).filter(User.id == current_user.id).first()
        if local_user:
            user_id = current_user.id

    user_name = getattr(current_user, 'name', None) or (current_user.email.split('@')[0].title() if current_user.email else None)

    # Only assign a ticket number for actual spray records (not issue/avoided).
    # Site spray records are herbicide lease sheets → HL prefix from herb_lease_seq.
    ticket_number = None
    if not payload.is_avoided:
        ticket_number = payload.ticket_number
        if not ticket_number:
            result = db.execute(text("SELECT nextval('herb_lease_seq')"))
            seq_value = result.scalar()
            ticket_number = f"HL{seq_value:06d}"

    # Handle Dropbox uploads — PDF + all photos go up in parallel via a
    # single thread-pool so a 10-photo lease sheet finishes in ~3 s
    # instead of ~15 s of serial Dropbox round-trips.
    pdf_url = None
    photo_urls: list[str] = []

    if payload.lease_sheet_data:
        lease_sheet_data = payload.lease_sheet_data.copy()
        lease_sheet_data['ticket_number'] = ticket_number

        # Build (content, path) jobs in a known order: PDF first (if any),
        # photos after. We track how many of each we queued so we can
        # split the parallel results back out into pdf_url / photo_urls.
        upload_jobs: list[tuple[bytes, str]] = []
        has_pdf = False

        if payload.pdf_base64:
            try:
                pdf_content = base64.b64decode(payload.pdf_base64)
                pdf_path = build_pdf_path(
                    date_str=str(payload.spray_date),
                    client=lease_sheet_data.get('customer', ''),
                    area=lease_sheet_data.get('area', ''),
                    ticket=ticket_number,
                    lsd_or_pipeline=lease_sheet_data.get('lsdOrPipeline', ''),
                )
                upload_jobs.append((pdf_content, pdf_path))
                has_pdf = True
            except Exception as e:
                print(f"Error decoding PDF base64: {e}")

        for i, photo_data in enumerate(lease_sheet_data.get('photos') or []):
            try:
                photo_content = base64.b64decode(photo_data.get('data', ''))
                photo_path = build_photo_path(ticket_number, i + 1)
                upload_jobs.append((photo_content, photo_path))
            except Exception as e:
                print(f"Error decoding photo {i+1} base64: {e}")

        if upload_jobs:
            results = upload_files_parallel(upload_jobs)
            if has_pdf:
                pdf_url = results[0]
                photo_urls = [u for u in results[1:] if u]
            else:
                photo_urls = [u for u in results if u]

    # Strip photos[].data before persisting — the actual images live in Dropbox
    # (URLs in photo_urls). Storing the base64 in the DB balloons egress.
    persisted_lease_data = _strip_photos_from_lease_data(payload.lease_sheet_data)

    record = SiteSprayRecord(
        site_id=site_id,
        spray_date=payload.spray_date,
        sprayed_by_user_id=user_id,
        sprayed_by_name=user_name,
        notes=payload.notes,
        is_avoided=payload.is_avoided,
        ticket_number=ticket_number,
        lease_sheet_data=persisted_lease_data,
        pdf_url=pdf_url,
        photo_urls=photo_urls if photo_urls else None,
        client_submission_id=payload.client_submission_id,
    )
    db.add(record)
    
    site_status = _site_status_from_spray_payload(payload)

    site.status = site_status
    if site_status in (SiteStatus.inspected, SiteStatus.in_progress):
        site.last_inspected_at = datetime.utcnow()
        if user_id:
            site.last_inspected_by_user_id = user_id
        if current_user.email:
            site.last_inspected_by_email = current_user.email
        if user_name:
            site.last_inspected_by_name = user_name
    site.updated_at = datetime.utcnow()

    db.flush()
    # Ensure site relationship is populated for row derivation
    record.site = site

    # ── Time & Materials linking (Phase 4) ──
    tm_link = getattr(payload, "time_materials_link", None)
    if tm_link and not payload.is_avoided:
        ticket = find_or_create_ticket_for_link(
            db=db,
            record=record,
            link_ticket_id=tm_link.ticket_id,
            link_create=tm_link.create,
            description_of_work=tm_link.description_of_work,
            current_user=current_user,
        )
        if ticket is not None:
            append_row_for_spray_record(db, ticket, record)
            # Upload new/updated T&M PDF if provided
            if tm_link.tm_pdf_base64:
                from app.time_materials_routes import _upload_tm_pdf
                new_url = _upload_tm_pdf(ticket, tm_link.tm_pdf_base64)
                if new_url:
                    ticket.pdf_url = new_url

    db.commit()
    db.refresh(record)
    return SiteSprayRecordRead.model_validate(record)


@app.post("/api/site-spray-records/{record_id}/files", response_model=SiteSprayRecordRead)
def attach_site_spray_record_files(
    record_id: int,
    payload: SprayRecordFilesUpload,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Lane-2 of the two-lane upload path — push the heavy PDF + photos to
    Dropbox for an already-created site spray record. Lane 1 (the existing
    `create_site_spray_record` endpoint, with files stripped out of the
    payload) creates the DB row + linked T&M ticket in well under a second
    so the worker is back at the map immediately; lane 2 streams the bytes
    to Dropbox in the background and patches `pdf_url` / `photo_urls`.

    Idempotent: Dropbox writes use overwrite mode and the patch overwrites
    `pdf_url` / `photo_urls` wholesale, so retrying after a network blip
    re-uploads to the same paths and re-patches the same row without
    producing duplicate Dropbox entries or burning a second HL ticket
    number.

    Works for both regular site spray records and the external lease sheet
    (both are `SiteSprayRecord` rows). Pipeline + hydroseed-daily have
    their own `/files` endpoints in `pipeline_routes` / `hydroseed_routes`.
    """
    import base64
    from app.dropbox_integration import upload_files_parallel, build_pdf_path, build_photo_path

    record = db.query(SiteSprayRecord).filter(
        SiteSprayRecord.id == record_id,
        SiteSprayRecord.deleted_at.is_(None),
    ).first()
    if not record:
        raise HTTPException(status_code=404, detail="Site spray record not found")

    # Workers can only attach files to their own records. Office / admin /
    # crew_lead can attach to any (mirrors the create endpoint's implicit
    # rule — the existing role gates on `update_site_spray_record` are
    # tighter than what's needed here because finishing an upload is
    # never destructive).
    if current_user.role == RoleEnum.worker and record.sprayed_by_user_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not your record")

    lease_sheet_data = record.lease_sheet_data or {}
    ticket_number = record.ticket_number or ''

    upload_jobs: list[tuple[bytes, str]] = []
    has_pdf = False

    if payload.pdf_base64:
        try:
            pdf_content = base64.b64decode(payload.pdf_base64)
            pdf_path = build_pdf_path(
                date_str=str(record.spray_date),
                client=lease_sheet_data.get('customer', ''),
                area=lease_sheet_data.get('area', ''),
                ticket=ticket_number,
                lsd_or_pipeline=lease_sheet_data.get('lsdOrPipeline', ''),
            )
            upload_jobs.append((pdf_content, pdf_path))
            has_pdf = True
        except Exception as e:
            print(f"[attach_site_spray_record_files] PDF decode error: {e}")

    for i, photo_data in enumerate(payload.photos or []):
        try:
            photo_content = base64.b64decode(photo_data.get('data', ''))
            photo_path = build_photo_path(ticket_number, i + 1)
            upload_jobs.append((photo_content, photo_path))
        except Exception as e:
            print(f"[attach_site_spray_record_files] photo {i+1} decode error: {e}")

    if upload_jobs:
        results = upload_files_parallel(upload_jobs)
        if has_pdf:
            if results[0]:
                record.pdf_url = results[0]
            photo_urls = [u for u in results[1:] if u]
        else:
            photo_urls = [u for u in results if u]
        if photo_urls:
            record.photo_urls = photo_urls

    # T&M PDF for the linked ticket (if any + provided). Same idempotency
    # story as above — the helper builds the same Dropbox path and
    # overwrite-uploads.
    if payload.tm_pdf_base64 and record.tm_ticket is not None:
        from app.time_materials_routes import _upload_tm_pdf
        new_url = _upload_tm_pdf(record.tm_ticket, payload.tm_pdf_base64)
        if new_url:
            record.tm_ticket.pdf_url = new_url

    # Bump updated_at so the next delta-sync tick broadcasts the new
    # pdf_url / photo_urls to the frontend list cache and the recently
    # submitted overlay.
    record.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(record)
    return SiteSprayRecordRead.model_validate(record)


@app.post("/api/external-lease-sheet", response_model=SiteSprayRecordRead)
def create_external_lease_sheet(
    payload: ExternalLeaseSheetCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Create a standalone lease sheet for a location not on the map."""
    import base64
    from app.dropbox_integration import upload_files_parallel, build_pdf_path, build_photo_path

    # ── Safety net: reject if matching non-hidden site exists ──
    lsd_value = (payload.lease_sheet_data or {}).get("lsdOrPipeline", "").strip()
    if lsd_value:
        client_value = (payload.lease_sheet_data or {}).get("customer", "").strip()
        area_value = (payload.lease_sheet_data or {}).get("area", "").strip()
        existing_site = (
            db.query(Site)
            .filter(
                Site.is_hidden.is_(False),
                Site.deleted_at.is_(None),
                Site.approval_state != ApprovalState.rejected,
                func.lower(Site.lsd) == lsd_value.lower(),
            )
        )
        if client_value:
            existing_site = existing_site.filter(func.lower(Site.client) == client_value.lower())
        if area_value:
            existing_site = existing_site.filter(func.lower(Site.area) == area_value.lower())
        existing_site = existing_site.first()
        if existing_site is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={"message": "A site with this location already exists on the map.", "site_id": existing_site.id},
            )

    # ── Idempotency check ──
    if payload.client_submission_id:
        existing = (
            db.query(SiteSprayRecord)
            .filter(
                SiteSprayRecord.client_submission_id == payload.client_submission_id,
                SiteSprayRecord.deleted_at.is_(None),
            )
            .first()
        )
        if existing is not None:
            return SiteSprayRecordRead.model_validate(existing)

    user_id = None
    if current_user.id:
        local_user = db.query(User).filter(User.id == current_user.id).first()
        if local_user:
            user_id = current_user.id

    user_name = getattr(current_user, 'name', None) or (current_user.email.split('@')[0].title() if current_user.email else None)

    # ── Create hidden placeholder site ──
    lat = payload.latitude if payload.latitude is not None else 0.0
    lng = payload.longitude if payload.longitude is not None else 0.0
    site = Site(
        pin_type=PinType.lsd,
        lsd=lsd_value or None,
        client=(payload.lease_sheet_data or {}).get("customer") or None,
        area=(payload.lease_sheet_data or {}).get("area") or None,
        latitude=lat,
        longitude=lng,
        status=SiteStatus.inspected,
        approval_state=ApprovalState.approved,
        source="external_form",
        is_hidden=True,
        created_by_user_id=user_id,
        last_inspected_at=datetime.utcnow(),
        last_inspected_by_user_id=user_id,
        last_inspected_by_email=current_user.email if current_user.email else None,
        last_inspected_by_name=user_name,
    )
    db.add(site)
    db.flush()

    # ── Ticket number ──
    ticket_number = None
    if not payload.is_avoided:
        ticket_number = payload.ticket_number
        if not ticket_number:
            result = db.execute(text("SELECT nextval('herb_lease_seq')"))
            seq_value = result.scalar()
            ticket_number = f"HL{seq_value:06d}"

    # ── Dropbox uploads — parallel batch (PDF + all photos at once) ──
    # Same pattern as create_site_spray_record above; see that function
    # for the shape rationale.
    pdf_url = None
    photo_urls: list[str] = []

    if payload.lease_sheet_data:
        lease_sheet_data = payload.lease_sheet_data.copy()
        lease_sheet_data['ticket_number'] = ticket_number

        upload_jobs: list[tuple[bytes, str]] = []
        has_pdf = False

        if payload.pdf_base64:
            try:
                pdf_content = base64.b64decode(payload.pdf_base64)
                pdf_path = build_pdf_path(
                    date_str=str(payload.spray_date),
                    client=lease_sheet_data.get('customer', ''),
                    area=lease_sheet_data.get('area', ''),
                    ticket=ticket_number,
                    lsd_or_pipeline=lease_sheet_data.get('lsdOrPipeline', ''),
                )
                upload_jobs.append((pdf_content, pdf_path))
                has_pdf = True
            except Exception as e:
                print(f"Error decoding PDF base64: {e}")

        for i, photo_data in enumerate(lease_sheet_data.get('photos') or []):
            try:
                photo_content = base64.b64decode(photo_data.get('data', ''))
                photo_path = build_photo_path(ticket_number, i + 1)
                upload_jobs.append((photo_content, photo_path))
            except Exception as e:
                print(f"Error decoding photo {i+1} base64: {e}")

        if upload_jobs:
            results = upload_files_parallel(upload_jobs)
            if has_pdf:
                pdf_url = results[0]
                photo_urls = [u for u in results[1:] if u]
            else:
                photo_urls = [u for u in results if u]

    persisted_lease_data = _strip_photos_from_lease_data(payload.lease_sheet_data)

    record = SiteSprayRecord(
        site_id=site.id,
        spray_date=payload.spray_date,
        sprayed_by_user_id=user_id,
        sprayed_by_name=user_name,
        notes=payload.notes,
        is_avoided=payload.is_avoided,
        ticket_number=ticket_number,
        lease_sheet_data=persisted_lease_data,
        pdf_url=pdf_url,
        photo_urls=photo_urls if photo_urls else None,
        client_submission_id=payload.client_submission_id,
    )
    db.add(record)
    db.flush()
    record.site = site

    # ── T&M linking ──
    tm_link = getattr(payload, "time_materials_link", None)
    if tm_link and not payload.is_avoided:
        ticket = find_or_create_ticket_for_link(
            db=db,
            record=record,
            link_ticket_id=tm_link.ticket_id,
            link_create=tm_link.create,
            description_of_work=tm_link.description_of_work,
            current_user=current_user,
        )
        if ticket is not None:
            append_row_for_spray_record(db, ticket, record)
            if tm_link.tm_pdf_base64:
                from app.time_materials_routes import _upload_tm_pdf
                new_url = _upload_tm_pdf(ticket, tm_link.tm_pdf_base64)
                if new_url:
                    ticket.pdf_url = new_url

    db.commit()
    db.refresh(record)
    return SiteSprayRecordRead.model_validate(record)


@app.delete("/api/site-spray-records/{record_id}", status_code=204)
def delete_site_spray_record(
    record_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_roles(*MANAGES_PINS)),
):
    """Soft-delete a site spray record. Unlinks its T&M rows so they become
    manual rows rather than orphaning them."""
    record = db.query(SiteSprayRecord).filter(SiteSprayRecord.id == record_id).first()
    if not record:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Site spray record not found")

    now = datetime.utcnow()
    record.deleted_at = now
    record.deleted_by_user_id = current_user.id

    # Unlink T&M rows so they become manual rows (ticket stays intact)
    for tm_row in list(record.tm_rows):
        tm_row.spray_record_id = None

    # DELTA-SYNC: bump the parent site's updated_at so the incremental
    # /api/sites/delta endpoint picks up this change.
    site = db.query(Site).filter(Site.id == record.site_id).first()
    if site is not None:
        site.updated_at = now

    db.commit()


@app.post("/api/site-spray-records/{record_id}/restore")
def restore_site_spray_record(
    record_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_roles(*MANAGES_PINS)),
):
    """Restore a soft-deleted site spray record."""
    record = db.query(SiteSprayRecord).filter(SiteSprayRecord.id == record_id).first()
    if not record:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Site spray record not found")
    if record.deleted_at is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Record is not deleted")

    record.deleted_at = None
    record.deleted_by_user_id = None
    db.commit()
    db.refresh(record)
    return {"success": True}


@app.delete("/api/site-spray-records/{record_id}/permanent", status_code=204)
def delete_site_spray_record_permanent(
    record_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_roles(RoleEnum.admin)),
):
    """Permanently delete a site spray record."""
    record = db.query(SiteSprayRecord).filter(SiteSprayRecord.id == record_id).first()
    if not record:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Site spray record not found")

    site = db.query(Site).filter(Site.id == record.site_id).first()
    if site is not None:
        site.updated_at = datetime.utcnow()

    db.delete(record)
    db.commit()


@app.patch("/api/site-spray-records/{record_id}", response_model=SiteSprayRecordRead)
def update_site_spray_record(
    record_id: int,
    payload: SiteSprayRecordUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update a site spray record (admin/office can edit anything; workers only their own)."""
    import base64
    from app.dropbox_integration import upload_pdf_to_dropbox, build_pdf_path
    from app.time_materials_routes import _upload_tm_pdf, append_row_for_spray_record

    record = db.query(SiteSprayRecord).filter(SiteSprayRecord.id == record_id).first()
    if not record:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Site spray record not found")

    # Permission: workers may only edit their own records
    if current_user.role not in MANAGES_PINS:
        if record.sprayed_by_user_id != current_user.id:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not allowed")

    # Update simple fields
    if payload.spray_date is not None:
        record.spray_date = payload.spray_date
    if payload.notes is not None:
        record.notes = payload.notes
    if payload.is_avoided is not None:
        record.is_avoided = payload.is_avoided
    if payload.lease_sheet_data is not None:
        # Strip photos[].data before persisting (see create endpoint)
        record.lease_sheet_data = _strip_photos_from_lease_data(payload.lease_sheet_data)

    # Re-upload PDF if new base64 is provided (replaces old PDF on Dropbox)
    if payload.pdf_base64:
        try:
            pdf_content = base64.b64decode(payload.pdf_base64)
            lease_data = payload.lease_sheet_data or record.lease_sheet_data or {}
            ticket = payload.ticket_number or record.ticket_number or ''
            pdf_path = build_pdf_path(
                date_str=str(payload.spray_date or record.spray_date),
                client=lease_data.get('customer', ''),
                area=lease_data.get('area', ''),
                ticket=ticket,
                lsd_or_pipeline=lease_data.get('lsdOrPipeline', ''),
            )
            new_pdf_url = upload_pdf_to_dropbox(pdf_content, pdf_path)
            if new_pdf_url:
                record.pdf_url = new_pdf_url
        except Exception as e:
            print(f"Error re-uploading PDF: {e}")

    # ── Cascade to linked T&M ticket row + regenerate its PDF (Phase 8) ──
    if record.tm_ticket_id is not None:
        ticket = db.query(TimeMaterialsTicket).filter(TimeMaterialsTicket.id == record.tm_ticket_id).first()
        if ticket is not None:
            append_row_for_spray_record(db, ticket, record)
            if payload.tm_pdf_base64:
                new_url = _upload_tm_pdf(ticket, payload.tm_pdf_base64)
                if new_url:
                    ticket.pdf_url = new_url

    # DELTA-SYNC: bump the parent site's updated_at so /api/sites/delta
    # surfaces this change on the next poll tick.
    site = db.query(Site).filter(Site.id == record.site_id).first()
    if site is not None:
        site.updated_at = datetime.utcnow()

    db.commit()
    db.refresh(record)
    return SiteSprayRecordRead.model_validate(record)


@app.get("/api/standalone-lease-sheets", response_model=list[RecentSubmissionRead])
def list_standalone_lease_sheets(
    search: str = Query(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_roles(*MANAGES_PINS)),
):
    """List lease sheets submitted as standalone (against a hidden placeholder site).

    These are candidates for linking to a visible pin via the move-to-site endpoint.
    Only admin/office can see and action these.
    """
    q = (
        db.query(
            SiteSprayRecord,
            Site.lsd.label('site_lsd'),
            Site.client.label('site_client'),
            Site.area.label('site_area'),
        )
        .options(defer(SiteSprayRecord.lease_sheet_data))
        .join(Site, SiteSprayRecord.site_id == Site.id)
        .filter(
            Site.is_hidden.is_(True),
            Site.deleted_at.is_(None),
            SiteSprayRecord.deleted_at.is_(None),
            SiteSprayRecord.lease_sheet_data.isnot(None),
        )
    )

    if search:
        search_term = f"%{search}%"
        q = q.filter(
            or_(
                SiteSprayRecord.ticket_number.ilike(search_term),
                SiteSprayRecord.sprayed_by_name.ilike(search_term),
                Site.lsd.ilike(search_term),
                Site.client.ilike(search_term),
                Site.area.ilike(search_term),
            )
        )

    rows = q.order_by(SiteSprayRecord.created_at.desc()).all()

    results: list[RecentSubmissionRead] = []
    for record, site_lsd, site_client, site_area in rows:
        data = SiteSprayRecordSummary.model_validate(record).model_dump()
        data['site_lsd'] = site_lsd
        data['site_client'] = site_client
        data['site_area'] = site_area
        results.append(RecentSubmissionRead(**data))
    return results


@app.post("/api/site-spray-records/{record_id}/move-to-site/{target_site_id}", response_model=SiteSprayRecordRead)
def move_spray_record_to_site(
    record_id: int,
    target_site_id: int,
    payload: MoveToSiteRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_roles(*MANAGES_PINS)),
):
    """Move a standalone lease-sheet spray record from its hidden placeholder site
    to a visible pin, applying the chosen inspection status to that pin.

    The hidden placeholder site is soft-deleted when it has no remaining
    non-deleted spray records after the move.
    """
    now = datetime.utcnow()

    # ── Validate record ──
    record = (
        db.query(SiteSprayRecord)
        .filter(SiteSprayRecord.id == record_id, SiteSprayRecord.deleted_at.is_(None))
        .first()
    )
    if not record:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Spray record not found")

    # Guard: source must be a hidden site (i.e., a standalone submission)
    source_site = db.query(Site).filter(Site.id == record.site_id).first()
    if not source_site or not source_site.is_hidden:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This spray record is already attached to a visible pin and cannot be moved.",
        )

    # ── Validate target site ──
    if target_site_id == record.site_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Source and target sites are the same.")

    target_site = (
        db.query(Site)
        .filter(Site.id == target_site_id, Site.deleted_at.is_(None), Site.is_hidden.is_(False))
        .first()
    )
    if not target_site:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Target site not found or is not a visible pin.")

    # ── Parse and validate target_status ──
    raw_status = payload.target_status if payload else "inspected"
    try:
        target_status = SiteStatus(raw_status)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f"Invalid target_status: {raw_status!r}")

    # ── Move the record ──
    old_site_id = record.site_id
    record.site_id = target_site_id

    # ── Update target site's inspection metadata ──
    target_site.status = target_status
    if target_status in (SiteStatus.inspected, SiteStatus.in_progress, SiteStatus.issue_not_inspected):
        # Use the spray record's original date/inspector so history is accurate
        target_site.last_inspected_at = record.spray_date if record.spray_date else now
        target_site.last_inspected_by_user_id = record.sprayed_by_user_id
        target_site.last_inspected_by_name = record.sprayed_by_name
    target_site.updated_at = now

    # ── Soft-delete the hidden source site if it has no remaining records ──
    remaining_count = (
        db.query(SiteSprayRecord)
        .filter(
            SiteSprayRecord.site_id == old_site_id,
            SiteSprayRecord.id != record_id,
            SiteSprayRecord.deleted_at.is_(None),
        )
        .count()
    )
    if remaining_count == 0 and source_site.deleted_at is None:
        source_site.deleted_at = now
        source_site.deleted_by_user_id = current_user.id
        # Keep updated_at current so delta feed ships the site in ids_removed
        source_site.updated_at = now
    else:
        # Still has records — just bump updated_at so delta can reflect the change
        source_site.updated_at = now

    db.commit()
    db.refresh(record)
    return SiteSprayRecordRead.model_validate(record)


@app.get("/api/recent-submissions", response_model=list[RecentSubmissionRead])
def list_recent_submissions(
    search: str = Query(default=None),
    before: datetime | None = Query(
        default=None,
        description=(
            "Optional pagination cursor: return only rows with created_at "
            "strictly less than this ISO timestamp. Use the oldest row's "
            "created_at from the previous page to fetch the next page."
        ),
    ),
    limit: int = Query(default=20, le=200),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List recent lease sheet submissions with search.

    EGRESS: lease_sheet_data is NOT selected (defer) — the summary response
    only needs scalar columns + joined site context. Default limit is 20
    for the first page. Pass `before=<oldest_created_at>` to fetch older
    pages (the FormsPanel "Load more" button uses this to walk back further
    than the initial cache holds).
    """
    site_q = (
        db.query(
            SiteSprayRecord,
            Site.lsd.label('site_lsd'),
            Site.client.label('site_client'),
            Site.area.label('site_area'),
        )
        .options(defer(SiteSprayRecord.lease_sheet_data))
        .join(Site, SiteSprayRecord.site_id == Site.id)
        .filter(
            SiteSprayRecord.lease_sheet_data.isnot(None),
            SiteSprayRecord.deleted_at.is_(None),
        )
    )

    pipeline_q = (
        db.query(
            SprayRecord,
            Pipeline.name.label('pipeline_name'),
            Pipeline.client.label('pipeline_client'),
            Pipeline.area.label('pipeline_area'),
        )
        .options(defer(SprayRecord.lease_sheet_data))
        .join(Pipeline, SprayRecord.pipeline_id == Pipeline.id)
        .filter(
            SprayRecord.lease_sheet_data.isnot(None),
            SprayRecord.deleted_at.is_(None),
        )
    )

    # Workers only see their OWN lease-sheet submissions. Office/admin see all.
    # Match on sprayed_by_user_id first; fall back to a name match for legacy
    # rows that predate the `users` table seed (sprayed_by_user_id IS NULL).
    if current_user.role == RoleEnum.worker:
        site_q = site_q.filter(
            or_(
                SiteSprayRecord.sprayed_by_user_id == current_user.id,
                and_(
                    SiteSprayRecord.sprayed_by_user_id.is_(None),
                    SiteSprayRecord.sprayed_by_name == current_user.name,
                ),
            )
        )
        pipeline_q = pipeline_q.filter(
            or_(
                SprayRecord.sprayed_by_user_id == current_user.id,
                and_(
                    SprayRecord.sprayed_by_user_id.is_(None),
                    SprayRecord.sprayed_by_name == current_user.name,
                ),
            )
        )

    # Pagination cursor: strict less-than so the boundary row from the
    # previous page isn't repeated. Applied to BOTH source tables so the
    # merged feed stays consistent.
    if before is not None:
        site_q = site_q.filter(SiteSprayRecord.created_at < before)
        pipeline_q = pipeline_q.filter(SprayRecord.created_at < before)

    if search:
        search_term = f"%{search}%"
        site_q = site_q.filter(
            or_(
                SiteSprayRecord.ticket_number.ilike(search_term),
                SiteSprayRecord.sprayed_by_name.ilike(search_term),
                Site.client.ilike(search_term),
                Site.area.ilike(search_term),
                Site.lsd.ilike(search_term),
            )
        )
        pipeline_q = pipeline_q.filter(
            or_(
                SprayRecord.ticket_number.ilike(search_term),
                SprayRecord.sprayed_by_name.ilike(search_term),
                Pipeline.client.ilike(search_term),
                Pipeline.area.ilike(search_term),
                Pipeline.name.ilike(search_term),
            )
        )

    site_rows = site_q.order_by(SiteSprayRecord.created_at.desc()).limit(limit).all()
    pipeline_rows = pipeline_q.order_by(SprayRecord.created_at.desc()).limit(limit).all()

    # Build the summary view without lease_sheet_data — the PDF preview
    # fetches the real Dropbox PDF via /api/pdf-proxy, and the edit flow
    # fetches the full row via /api/site-spray-records/{id}.
    results: list[RecentSubmissionRead] = []
    for record, site_lsd, site_client, site_area in site_rows:
        data = SiteSprayRecordSummary.model_validate(record).model_dump()
        data['site_lsd'] = site_lsd
        data['site_client'] = site_client
        data['site_area'] = site_area
        results.append(RecentSubmissionRead(**data))
    for record, pipeline_name, pipeline_client, pipeline_area in pipeline_rows:
        results.append(RecentSubmissionRead(
            id=record.id,
            site_id=None,
            pipeline_id=record.pipeline_id,
            spray_date=record.spray_date,
            sprayed_by_user_id=record.sprayed_by_user_id,
            sprayed_by_name=record.sprayed_by_name,
            notes=record.notes,
            is_avoided=record.is_avoided,
            created_at=record.created_at,
            ticket_number=record.ticket_number,
            pdf_url=record.pdf_url,
            photo_urls=record.photo_urls,
            tm_ticket_id=None,
            site_lsd=pipeline_name,
            site_client=pipeline_client,
            site_area=pipeline_area,
        ))

    # Merge the two per-table results into one newest-first feed, then cap
    # at `limit` so the response size matches the documented contract.
    results.sort(key=lambda r: r.created_at, reverse=True)
    return results[:limit]


@app.get("/api/recent-submissions/delta", response_model=RecentSubmissionsDeltaResponse)
def recent_submissions_delta(
    since: datetime = Query(..., description="ISO timestamp from a previous server_time"),
    limit: int = Query(default=100, le=500),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> RecentSubmissionsDeltaResponse:
    """Incremental recent-submissions sync — rows created or touched since `since`.

    Ships `ids_removed` for soft-deleted lease sheets so the frontend can
    prune its cache. Limit is generous (100) because in practice far fewer
    rows land between 30s polls; the cap only matters when a client comes
    back from a long absence.
    """
    server_time = datetime.utcnow()

    site_q = (
        db.query(
            SiteSprayRecord,
            Site.lsd.label('site_lsd'),
            Site.client.label('site_client'),
            Site.area.label('site_area'),
        )
        .options(defer(SiteSprayRecord.lease_sheet_data))
        .join(Site, SiteSprayRecord.site_id == Site.id)
        .filter(
            SiteSprayRecord.lease_sheet_data.isnot(None),
            SiteSprayRecord.updated_at > since,
            SiteSprayRecord.deleted_at.is_(None),
        )
    )

    pipeline_q = (
        db.query(
            SprayRecord,
            Pipeline.name.label('pipeline_name'),
            Pipeline.client.label('pipeline_client'),
            Pipeline.area.label('pipeline_area'),
        )
        .options(defer(SprayRecord.lease_sheet_data))
        .join(Pipeline, SprayRecord.pipeline_id == Pipeline.id)
        .filter(
            SprayRecord.lease_sheet_data.isnot(None),
            SprayRecord.updated_at > since,
            SprayRecord.deleted_at.is_(None),
        )
    )

    # Match the privacy rule in /api/recent-submissions: workers see only
    # their own submissions in the delta feed too, otherwise the 2-min poll
    # would leak other workers' rows into the Recently Submitted list.
    if current_user.role == RoleEnum.worker:
        site_q = site_q.filter(
            or_(
                SiteSprayRecord.sprayed_by_user_id == current_user.id,
                and_(
                    SiteSprayRecord.sprayed_by_user_id.is_(None),
                    SiteSprayRecord.sprayed_by_name == current_user.name,
                ),
            )
        )
        pipeline_q = pipeline_q.filter(
            or_(
                SprayRecord.sprayed_by_user_id == current_user.id,
                and_(
                    SprayRecord.sprayed_by_user_id.is_(None),
                    SprayRecord.sprayed_by_name == current_user.name,
                ),
            )
        )

    site_q = site_q.order_by(SiteSprayRecord.updated_at.desc()).limit(limit)
    pipeline_q = pipeline_q.order_by(SprayRecord.updated_at.desc()).limit(limit)

    items: list[RecentSubmissionRead] = []
    for record, site_lsd, site_client, site_area in site_q.all():
        data = SiteSprayRecordSummary.model_validate(record).model_dump()
        data['site_lsd'] = site_lsd
        data['site_client'] = site_client
        data['site_area'] = site_area
        items.append(RecentSubmissionRead(**data))
    for record, pipeline_name, pipeline_client, pipeline_area in pipeline_q.all():
        items.append(RecentSubmissionRead(
            id=record.id,
            site_id=None,
            pipeline_id=record.pipeline_id,
            spray_date=record.spray_date,
            sprayed_by_user_id=record.sprayed_by_user_id,
            sprayed_by_name=record.sprayed_by_name,
            notes=record.notes,
            is_avoided=record.is_avoided,
            created_at=record.created_at,
            ticket_number=record.ticket_number,
            pdf_url=record.pdf_url,
            photo_urls=record.photo_urls,
            tm_ticket_id=None,
            site_lsd=pipeline_name,
            site_client=pipeline_client,
            site_area=pipeline_area,
        ))

    items.sort(key=lambda r: r.created_at, reverse=True)
    items = items[:limit]

    # Soft-deleted lease sheet IDs since `since`
    ids_removed: list[int] = []
    removed_site = (
        db.query(SiteSprayRecord.id)
        .filter(
            SiteSprayRecord.lease_sheet_data.isnot(None),
            SiteSprayRecord.deleted_at > since,
        )
        .all()
    )
    removed_pipeline = (
        db.query(SprayRecord.id)
        .filter(
            SprayRecord.lease_sheet_data.isnot(None),
            SprayRecord.deleted_at > since,
        )
        .all()
    )
    ids_removed = [r[0] for r in removed_site] + [r[0] for r in removed_pipeline]

    return RecentSubmissionsDeltaResponse(
        items=items, ids_removed=ids_removed, server_time=server_time
    )


@app.patch("/api/sites/{site_id}/status", response_model=SiteRead)
def update_site_status(
    site_id: int,
    payload: SiteStatusUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> SiteRead:
    site = get_site_or_404(db, site_id)
    site.status = payload.status
    site.updated_at = datetime.utcnow()
    if payload.status in (SiteStatus.inspected, SiteStatus.in_progress):
        site.last_inspected_at = datetime.utcnow()

        # Store user ID, email, and name who inspected (the three are
        # mirrored onto the site row so the Recently Inspected list can
        # show attribution even if the user record is later deleted).
        if current_user.id and current_user.id > 0:
            # Only set FK if user exists in local DB
            local_user = db.query(User).filter(User.id == current_user.id).first()
            if local_user:
                site.last_inspected_by_user_id = current_user.id
        if current_user.email:
            site.last_inspected_by_email = current_user.email
        if current_user.name:
            site.last_inspected_by_name = current_user.name

    update = SiteUpdate(
        site_id=site.id,
        status=payload.status,
        note=payload.note,
        sync_status="synced",
    )
    db.add(update)
    db.commit()
    db.refresh(site)
    return SiteRead.model_validate(site)


@app.delete(
    "/api/sites/{site_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_roles(*MANAGES_PINS))],
)
def delete_site(
    site_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> None:
    site = get_site_or_404(db, site_id)
    site.deleted_at = datetime.utcnow()
    # Only set deleted_by_user_id if user exists in local DB to avoid FK constraint
    if current_user.id:
        # Check if user exists in local database
        local_user = db.query(User).filter(User.id == current_user.id).first()
        if local_user:
            site.deleted_by_user_id = current_user.id
    site.updated_at = datetime.utcnow()
    db.commit()


@app.delete(
    "/api/sites/{site_id}/permanent",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_roles(RoleEnum.admin))],
)
def delete_site_permanent(
    site_id: int,
    db: Session = Depends(get_db),
) -> None:
    site = get_site_or_404(db, site_id)
    db.delete(site)
    db.commit()


@app.post(
    "/api/sites/{site_id}/approval",
    response_model=SiteRead,
    dependencies=[Depends(require_roles(*MANAGES_PINS))],
)
def update_site_approval(
    site_id: int,
    payload: SiteApprovalUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> SiteRead:
    """Approve or reject a pending pin, cascading any metadata corrections.

    Two guardrails beyond the old flow:

    1. REJECT GUARD — a pending pin that already has linked lease sheets
       cannot be rejected. Admin must first delete the lease sheets (and
       their T&M rows cascade out) before re-trying reject, so we never
       silently drop billable work.

    2. META CASCADE ON APPROVE — when the admin corrects lsd/client/area
       at approval time we also rewrite the lease_sheet_data snapshot for
       every linked spray record, refresh TimeMaterialsRow.location, and
       either update a DEDICATED ticket's client/area in place OR force a
       re-home to a freshly-picked ticket when the current one is SHARED
       with other spray records. The admin must pre-pick the re-home
       ticket (tm_link in spray_record_updates) before the request is
       accepted — otherwise we 409 with the list of open tickets to pick
       from, and nothing is mutated.
    """
    import base64
    from app.dropbox_integration import build_pdf_path, upload_pdf_to_dropbox
    from app.time_materials_routes import _upload_tm_pdf

    site = get_site_or_404(db, site_id)

    # Eager-load spray records + each record's ticket and rows so
    # classify_ticket_ownership has what it needs without N+1 queries.
    linked_records = (
        db.query(SiteSprayRecord)
        .options(
            joinedload(SiteSprayRecord.tm_ticket).joinedload(TimeMaterialsTicket.rows),
        )
        .filter(SiteSprayRecord.site_id == site.id)
        .all()
    )

    # ── Reject branch ────────────────────────────────────────────────
    if payload.approval_state == ApprovalState.rejected:
        if linked_records:
            # Hard block — admin must clean up lease sheets first. The
            # frontend uses this structured payload to show a modal
            # listing the offending sheets with deep-link actions.
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "reason": "has_linked_spray_records",
                    "linked_spray_records": [
                        {
                            "id": r.id,
                            "ticket_number": r.ticket_number,
                            "tm_ticket_id": r.tm_ticket_id,
                            "spray_date": (
                                r.spray_date.isoformat() if r.spray_date else None
                            ),
                            "is_avoided": r.is_avoided,
                        }
                        for r in linked_records
                    ],
                },
            )
        # Pending field-added pin with no linked sheets → soft delete.
        # We used to `db.delete(site)` here, but a hard-delete leaves no
        # trail in the `/api/sites/delta` watermark stream:
        #   • the row is gone, so it can't appear in `items`
        #     (filtered by `deleted_at.is_(None) AND approval_state !=
        #     rejected`), and
        #   • it can't appear in `ids_removed` either, because that
        #     query also requires `updated_at > since` on the (now
        #     non-existent) row.
        # Plus `sites_last_updated = max(updated_at)` doesn't bump on a
        # hard-delete, so `sitesChanged` is false on the next poll tick
        # and `syncSitesIncrementally` doesn't even run. The net effect
        # was that any client without Supabase Realtime enabled (or any
        # second admin device that wasn't the one doing the reject) kept
        # the orange "!" marker on the map until the next cold start
        # forced a /api/sites re-fetch — the "reject leaves the
        # exclamation mark on the map" bug report.
        #
        # Soft-deleting (approval_state=rejected + deleted_at=now) puts
        # the pin into BOTH /api/sites/delta's `ids_removed` channel AND
        # the realtime UPDATE stream, so every client converges within
        # one poll tick (or instantly if realtime is on). The pin also
        # shows up in Recent Deletes for audit, which admins can
        # permanently purge from there.
        if site.source == "field_added" and site.approval_state == ApprovalState.pending_review:
            site.approval_state = ApprovalState.rejected
            site.deleted_at = datetime.utcnow()
            site.updated_at = datetime.utcnow()
            if current_user.id:
                local_user = db.query(User).filter(User.id == current_user.id).first()
                if local_user:
                    site.deleted_by_user_id = current_user.id
            db.commit()
            db.refresh(site)
            return SiteRead.model_validate(site)
        # Otherwise this is an "abandon pending changes" revert for a
        # pin that was already approved before.
        site.approval_state = ApprovalState.approved
        site.pending_pin_type = None
        site.pending_change_requested_by_user_id = None
        site.pending_change_requested_by_name = None
        site.updated_at = datetime.utcnow()
        if current_user.id:
            local_user = db.query(User).filter(User.id == current_user.id).first()
            if local_user:
                site.approved_by_user_id = current_user.id
        db.commit()
        db.refresh(site)
        return SiteRead.model_validate(site)

    # ── Approve branch ──────────────────────────────────────────────
    # Compute whether lsd/client/area is actually being changed so we
    # know whether the cascade needs to run at all.
    new_lsd = payload.lsd if payload.lsd is not None else site.lsd
    new_client = payload.client if payload.client is not None else site.client
    new_area = payload.area if payload.area is not None else site.area
    is_meta_change = (
        (payload.lsd is not None and payload.lsd != site.lsd)
        or (payload.client is not None and payload.client != site.client)
        or (payload.area is not None and payload.area != site.area)
    )

    updates_by_id = {
        u.spray_record_id: u for u in (payload.spray_record_updates or [])
    }

    # Validate re-home coverage BEFORE mutating anything. If any linked
    # record sits on a shared ticket and meta is changing, we need a
    # tm_link for it — otherwise 409 with the open-tickets list so the
    # admin UI can render the picker.
    if is_meta_change and linked_records:
        shared_conflicts: list[dict] = []
        for record in linked_records:
            if record.is_avoided:
                continue  # avoided sheets have no T&M rows
            ownership = classify_ticket_ownership(record.tm_ticket, record)
            if ownership != "shared":
                continue
            update = updates_by_id.get(record.id)
            if update is None or update.tm_link is None:
                shared_conflicts.append(
                    {
                        "spray_record_id": record.id,
                        "ticket_number": record.ticket_number,
                        "current_tm_ticket_id": record.tm_ticket_id,
                        "current_tm_ticket_number": (
                            record.tm_ticket.ticket_number if record.tm_ticket else None
                        ),
                        "spray_date": (
                            record.spray_date.isoformat() if record.spray_date else None
                        ),
                    }
                )
        if shared_conflicts:
            # Gather open tickets matching the corrected client/area and
            # each distinct spray_date so the admin UI's T&M picker can
            # show only relevant options.
            spray_dates = {
                c["spray_date"] for c in shared_conflicts if c.get("spray_date")
            }
            open_tickets: list[dict] = []
            if new_client and new_area and spray_dates:
                ticket_rows = (
                    db.query(TimeMaterialsTicket)
                    .filter(
                        TimeMaterialsTicket.deleted_at.is_(None),
                        TimeMaterialsTicket.client == new_client,
                        TimeMaterialsTicket.area == new_area,
                    )
                    .order_by(TimeMaterialsTicket.created_at.desc())
                    .all()
                )
                for t in ticket_rows:
                    t_date = t.spray_date.isoformat() if t.spray_date else None
                    if t_date in spray_dates:
                        open_tickets.append(
                            {
                                "id": t.id,
                                "ticket_number": t.ticket_number,
                                "client": t.client,
                                "area": t.area,
                                "spray_date": t_date,
                                "status": t.status.value if hasattr(t.status, "value") else t.status,
                            }
                        )
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "reason": "shared_tm_ticket_needs_rehome",
                    "shared_ticket_conflicts": shared_conflicts,
                    "open_tm_tickets": open_tickets,
                },
            )

    # Validation passed — apply everything inside one transaction.
    if current_user.id:
        local_user = db.query(User).filter(User.id == current_user.id).first()
        if local_user:
            site.approved_by_user_id = current_user.id
    site.updated_at = datetime.utcnow()
    site.approval_state = ApprovalState.approved
    if site.pending_pin_type is not None:
        site.pin_type = site.pending_pin_type
        site.pending_pin_type = None
    site.pending_change_requested_by_user_id = None
    site.pending_change_requested_by_name = None

    if payload.lsd is not None:
        site.lsd = payload.lsd
    if payload.client is not None:
        site.client = payload.client
    if payload.area is not None:
        site.area = payload.area
    if payload.notes is not None:
        site.notes = payload.notes
    if payload.gate_code is not None:
        site.gate_code = payload.gate_code
    if payload.phone_number is not None:
        site.phone_number = payload.phone_number

    # Cascade metadata corrections to every linked spray record.
    if is_meta_change:
        for record in linked_records:
            update = updates_by_id.get(record.id)
            # 1. Rewrite the lease_sheet_data snapshot so the lease sheet
            #    (and its PDF, regenerated below) matches the corrected
            #    site. Avoided sheets still get this update so the
            #    historical report names the right client/area/LSD.
            data = dict(record.lease_sheet_data or {})
            if payload.client is not None:
                data["customer"] = payload.client
            if payload.area is not None:
                data["area"] = payload.area
            if payload.lsd is not None:
                # lsdOrPipeline is the free-form "location" field on the
                # lease sheet; for site pins it tracks site.lsd.
                data["lsdOrPipeline"] = payload.lsd
            record.lease_sheet_data = data

            # 2. Replace the lease-sheet PDF on Dropbox with a freshly
            #    rendered one if the admin UI supplied it. Old object is
            #    abandoned under its previous path — we never rename /
            #    delete on Dropbox (mirrors create/update flows).
            if update and update.lease_pdf_base64:
                try:
                    pdf_content = base64.b64decode(update.lease_pdf_base64)
                    pdf_path = build_pdf_path(
                        date_str=str(record.spray_date),
                        client=data.get("customer", "") or "",
                        area=data.get("area", "") or "",
                        ticket=record.ticket_number or "",
                        lsd_or_pipeline=data.get("lsdOrPipeline", "") or "",
                    )
                    new_url = upload_pdf_to_dropbox(pdf_content, pdf_path)
                    if new_url:
                        record.pdf_url = new_url
                except Exception as e:  # noqa: BLE001 — log and continue
                    print(f"[APPROVE] Lease PDF upload failed for record {record.id}: {e}")

            # Avoided sheets have no T&M ticket — skip the re-home work.
            if record.is_avoided:
                continue

            ownership = classify_ticket_ownership(record.tm_ticket, record)
            if ownership == "dedicated" and record.tm_ticket is not None:
                # Update the ticket header in place; re-append rows so
                # location/site_type are re-derived from the new data.
                record.tm_ticket.client = new_client or record.tm_ticket.client
                record.tm_ticket.area = new_area or record.tm_ticket.area
                append_row_for_spray_record(db, record.tm_ticket, record)
                b64_pdf = None
                if update and update.tm_pdf_base64:
                    b64_pdf = update.tm_pdf_base64
                elif payload.dedicated_tm_pdf_base64:
                    b64_pdf = payload.dedicated_tm_pdf_base64
                if b64_pdf:
                    new_url = _upload_tm_pdf(record.tm_ticket, b64_pdf)
                    if new_url:
                        record.tm_ticket.pdf_url = new_url
            elif ownership == "shared":
                # Detach rows from the old shared ticket and re-home on a
                # picked (or newly-created) ticket.
                old_ticket = record.tm_ticket
                detach_rows_for_record(db, old_ticket, record)
                record.tm_ticket_id = None
                new_ticket = find_or_create_ticket_for_link(
                    db=db,
                    record=record,
                    link_ticket_id=(update.tm_link.ticket_id if update and update.tm_link else None),
                    link_create=bool(update and update.tm_link and update.tm_link.create),
                    description_of_work=(
                        update.tm_link.description_of_work if update and update.tm_link else None
                    ),
                    current_user=current_user,
                )
                if new_ticket is not None:
                    append_row_for_spray_record(db, new_ticket, record)
                    b64_pdf = None
                    if update and update.tm_link and update.tm_link.tm_pdf_base64:
                        b64_pdf = update.tm_link.tm_pdf_base64
                    elif update and update.tm_pdf_base64:
                        b64_pdf = update.tm_pdf_base64
                    if b64_pdf:
                        new_url = _upload_tm_pdf(new_ticket, b64_pdf)
                        if new_url:
                            new_ticket.pdf_url = new_url
            # ownership == "none": no ticket to cascade into; skip.

    db.commit()
    db.refresh(site)
    return SiteRead.model_validate(site)


@app.post("/api/sites/{site_id}/request-type-change", response_model=SiteRead)
def request_type_change(
    site_id: int,
    payload: TypeChangeRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> SiteRead:
    site = get_site_or_404(db, site_id)

    if site.pin_type == payload.pin_type:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Site is already of type {payload.pin_type.value}",
        )

    site.pending_pin_type = payload.pin_type
    site.approval_state = ApprovalState.pending_review
    site.updated_at = datetime.utcnow()
    # Stamp the requester so admins can see who asked for the change in the
    # Pending Approvals list. The FK is set only if the user is in the local
    # users table (mirrors create_site's FK guard); the denormalized name
    # always gets stamped so Supabase Realtime payloads carry it across.
    if current_user.id:
        local_user = db.query(User).filter(User.id == current_user.id).first()
        if local_user:
            site.pending_change_requested_by_user_id = current_user.id
    site.pending_change_requested_by_name = (current_user.name or current_user.email or None)
    db.commit()
    db.refresh(site)
    return SiteRead.model_validate(site)


@app.post(
    "/api/admin/reset-status",
    response_model=BulkResetResponse,
    dependencies=[Depends(require_roles(RoleEnum.admin, RoleEnum.office))],
)
def bulk_reset_status(
    payload: BulkResetRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> BulkResetResponse:
    if not payload.client and not payload.area:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Select at least one client or area before running a bulk reset",
        )

    query = db.query(Site).filter(Site.approval_state != ApprovalState.rejected)
    if payload.client:
        query = query.filter(Site.client == payload.client)
    if payload.area:
        query = query.filter(Site.area == payload.area)

    sites = query.all()
    for site in sites:
        site.status = SiteStatus.not_inspected
        site.last_inspected_at = None
        site.updated_at = datetime.utcnow()
        db.add(
            SiteUpdate(
                site_id=site.id,
                status=SiteStatus.not_inspected,
                note="Bulk reset to not inspected",
                created_by_user_id=current_user.id if current_user.id else None,
                sync_status="synced",
            )
        )

    db.commit()
    return BulkResetResponse(reset_count=len(sites))


@app.post(
    "/api/import/kml",
    response_model=KmlImportResponse,
    dependencies=[Depends(require_roles(RoleEnum.admin, RoleEnum.office))],
)
def import_kml(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> KmlImportResponse:
    contents = file.file.read()
    if not contents:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Uploaded KML file is empty")

    source_name = file.filename or "uploaded.kml"
    imported_sites = parse_kml_file(contents, source_name=source_name)
    existing_sites = (
        db.query(Site)
        .filter(Site.source == "imported", Site.source_name == source_name)
        .all()
    )
    for existing_site in existing_sites:
        db.delete(existing_site)
    db.flush()

    for site_data in imported_sites:
        db.add(
            Site(
                **site_data,
                approval_state=ApprovalState.approved,
                created_by_user_id=current_user.id if current_user.id else None,
                approved_by_user_id=current_user.id if current_user.id else None,
            )
        )

    db.commit()
    return KmlImportResponse(imported_count=len(imported_sites))


@app.get(
    "/api/deleted-sites",
    response_model=list[SiteRead],
    dependencies=[Depends(require_roles(*MANAGES_PINS))],
)
def list_deleted_sites(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[SiteRead]:
    sites = (
        db.query(Site)
        .options(joinedload(Site.updates))
        .filter(Site.deleted_at.isnot(None))
        .order_by(Site.deleted_at.desc())
        .all()
    )
    return [SiteRead.model_validate(site) for site in sites]


@app.get(
    "/api/deleted-lease-sheets",
    response_model=list[RecentSubmissionRead],
    dependencies=[Depends(require_roles(*MANAGES_PINS))],
)
def list_deleted_lease_sheets(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[RecentSubmissionRead]:
    """List soft-deleted lease sheets (site and pipeline)."""
    site_q = (
        db.query(
            SiteSprayRecord,
            Site.lsd.label('site_lsd'),
            Site.client.label('site_client'),
            Site.area.label('site_area'),
        )
        .options(defer(SiteSprayRecord.lease_sheet_data))
        .join(Site, SiteSprayRecord.site_id == Site.id)
        .filter(
            SiteSprayRecord.lease_sheet_data.isnot(None),
            SiteSprayRecord.deleted_at.isnot(None),
        )
        .order_by(SiteSprayRecord.deleted_at.desc())
    )

    pipeline_q = (
        db.query(
            SprayRecord,
            Pipeline.name.label('pipeline_name'),
            Pipeline.client.label('pipeline_client'),
            Pipeline.area.label('pipeline_area'),
        )
        .options(defer(SprayRecord.lease_sheet_data))
        .join(Pipeline, SprayRecord.pipeline_id == Pipeline.id)
        .filter(
            SprayRecord.lease_sheet_data.isnot(None),
            SprayRecord.deleted_at.isnot(None),
        )
        .order_by(SprayRecord.deleted_at.desc())
    )

    results: list[RecentSubmissionRead] = []
    for record, site_lsd, site_client, site_area in site_q.all():
        data = SiteSprayRecordSummary.model_validate(record).model_dump()
        data['site_lsd'] = site_lsd
        data['site_client'] = site_client
        data['site_area'] = site_area
        results.append(RecentSubmissionRead(**data))
    for record, pipeline_name, pipeline_client, pipeline_area in pipeline_q.all():
        results.append(RecentSubmissionRead(
            id=record.id,
            site_id=None,
            pipeline_id=record.pipeline_id,
            spray_date=record.spray_date,
            sprayed_by_user_id=record.sprayed_by_user_id,
            sprayed_by_name=record.sprayed_by_name,
            notes=record.notes,
            is_avoided=record.is_avoided,
            created_at=record.created_at,
            ticket_number=record.ticket_number,
            pdf_url=record.pdf_url,
            photo_urls=record.photo_urls,
            tm_ticket_id=None,
            site_lsd=pipeline_name,
            site_client=pipeline_client,
            site_area=pipeline_area,
        ))

    results.sort(key=lambda r: r.created_at, reverse=True)
    return results


@app.post(
    "/api/sites/{site_id}/restore",
    response_model=SiteRead,
    dependencies=[Depends(require_roles(*MANAGES_PINS))],
)
def restore_site(
    site_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> SiteRead:
    site = get_site_or_404(db, site_id)
    if site.deleted_at is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Site is not deleted",
        )
    site.deleted_at = None
    site.deleted_by_user_id = None
    site.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(site)
    return SiteRead.model_validate(site)


@app.get("/api/pdf-proxy")
async def pdf_proxy(
    url: str = Query(..., description="Dropbox shared link URL"),
    current_user: User = Depends(get_current_user),
):
    """Proxy a Dropbox PDF to avoid CORS/iframe issues. Returns raw PDF bytes."""
    import httpx

    # Convert Dropbox shared link to direct download URL
    download_url = url
    if 'dropbox.com' in download_url:
        download_url = (
            download_url
            .replace('www.dropbox.com', 'dl.dropboxusercontent.com')
            .replace('&dl=0', '').replace('?dl=0', '?').replace('dl=1', '')
        )
        # Clean trailing ? or &
        download_url = download_url.rstrip('?&')

    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=30.0) as client:
            resp = await client.get(download_url)
            if resp.status_code != 200:
                raise HTTPException(status_code=502, detail=f"Dropbox returned {resp.status_code}")
            # Lease-sheet PDFs are immutable in practice (admin re-upload
            # is rare). `private` because the endpoint is auth-gated —
            # the requesting browser may cache, but shared caches /
            # proxies must not. 1 hour balances repeat-view egress
            # savings against the unlikely re-upload staleness window.
            return StreamingResponse(
                iter([resp.content]),
                media_type="application/pdf",
                headers={
                    "Content-Disposition": "inline; filename=lease_sheet.pdf",
                    "Cache-Control": "private, max-age=3600",
                },
            )
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Timeout fetching PDF from Dropbox")
    except Exception as e:
        print(f"[PDF_PROXY] Error: {type(e).__name__}: {e}")
        raise HTTPException(status_code=502, detail="Failed to fetch PDF")


from pydantic import BaseModel


class PhotoProxyRequest(BaseModel):
    url: str


class DraftPhotoUploadRequest(BaseModel):
    draft_id: str
    index: int
    data: str       # base64 (no data: prefix)
    type: str | None = None


class DraftPhotoDeleteRequest(BaseModel):
    draft_id: str


@app.post("/api/lease-sheet-drafts/photo")
def upload_draft_photo(
    payload: DraftPhotoUploadRequest,
    current_user: User = Depends(get_current_user),
):
    """Best-effort backup of a lease-sheet draft photo to Dropbox.

    Used as a safety net against iOS Safari IndexedDB quota issues: workers'
    photos sometimes don't survive a draft round-trip on iPhone, so we stash
    a copy in Dropbox keyed by (user_id, draft_id, index). On draft restore
    the frontend falls back to fetching from this URL via proxy-photo if the
    local IndexedDB copy is gone. Folder is cleaned up when the draft is
    deleted (see DELETE endpoint below)."""
    import base64
    from app.dropbox_integration import upload_photo_to_dropbox, build_draft_photo_path

    try:
        photo_bytes = base64.b64decode(payload.data)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid base64 data")

    path = build_draft_photo_path(str(current_user.id), payload.draft_id, payload.index)
    url = upload_photo_to_dropbox(photo_bytes, path)
    if not url:
        raise HTTPException(status_code=502, detail="Dropbox upload failed")
    return {"url": url}


@app.post("/api/lease-sheet-drafts/photo/delete")
def delete_draft_photos(
    payload: DraftPhotoDeleteRequest,
    current_user: User = Depends(get_current_user),
):
    """Best-effort cleanup of a draft's Dropbox photo folder. Called when a
    worker deletes a draft locally. Failure is non-fatal."""
    from app.dropbox_integration import delete_dropbox_path, _safe_name

    folder = f"/Pineview Maps/Drafts/{_safe_name(str(current_user.id))}/{_safe_name(payload.draft_id)}"
    ok = delete_dropbox_path(folder)
    return {"ok": ok}


@app.post("/api/proxy-photo")
async def proxy_photo(
    payload: PhotoProxyRequest,
    current_user: User = Depends(get_current_user),
):
    """Proxy a Dropbox image to avoid CORS issues. Returns base64 data and MIME type."""
    import httpx
    import base64

    # Convert Dropbox shared link to direct download URL
    download_url = payload.url
    if 'dropbox.com' in download_url:
        download_url = (
            download_url
            .replace('www.dropbox.com', 'dl.dropboxusercontent.com')
            .replace('&dl=0', '').replace('?dl=0', '?').replace('dl=1', '')
        )
        # Clean trailing ? or &
        download_url = download_url.rstrip('?&')

    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=30.0) as client:
            resp = await client.get(download_url)
            if resp.status_code != 200:
                raise HTTPException(status_code=502, detail=f"Image source returned {resp.status_code}")
            
            # Detect MIME type from Content-Type header
            content_type = resp.headers.get("content-type", "image/jpeg")
            
            # Convert to base64
            base64_data = base64.b64encode(resp.content).decode("utf-8")
            
            # Same caching rationale as pdf_proxy above: photos are
            # immutable in practice; `private` keeps the response out of
            # shared caches because the endpoint is auth-gated; 1 hour
            # max-age cuts repeat-view egress on the worker's device
            # (gallery scrubs, lease-sheet preview re-opens, etc.).
            return JSONResponse(
                content={"data": base64_data, "type": content_type},
                headers={"Cache-Control": "private, max-age=3600"},
            )
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Timeout fetching image from Dropbox")
    except Exception as e:
        print(f"[PHOTO_PROXY] Error: {type(e).__name__}: {e}")
        raise HTTPException(status_code=502, detail="Failed to fetch image")