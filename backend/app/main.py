from datetime import datetime

from fastapi import Depends, FastAPI, File, HTTPException, Query, Request, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from sqlalchemy import inspect, or_, text
from sqlalchemy.orm import Session, joinedload

from app.auth import get_current_user, require_roles, seed_demo_users
from app.config import get_settings
from app.database import Base, SessionLocal, engine, get_db
from app.kml_import import parse_kml_file
from app.password_reset import router as password_reset_router
from app.user_management import router as user_management_router
from app.pipeline_routes import router as pipeline_router
from app.lookup_routes import router as lookup_router
from app.pipeline_models import Pipeline, SprayRecord  # noqa: F401 — ensure tables are registered
from app.models import (
    ApprovalState,
    PinType,
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
    find_or_create_ticket_for_link,
    router as time_materials_router,
)
from app.schemas import (
    BulkResetRequest,
    BulkResetResponse,
    KmlImportResponse,
    RecentSubmissionRead,
    SessionResponse,
    SiteAdminUpdate,
    SiteApprovalUpdate,
    SiteCreate,
    SiteQuickEdit,
    SiteRead,
    SiteSprayRecordRead,
    SiteSprayRecordSummary,
    SiteSprayRecordCreate,
    SiteSprayRecordUpdate,
    SiteStatusUpdate,
    TypeChangeRequest,
)

settings = get_settings()
app = FastAPI(title=settings.app_name)

# Add CORS middleware FIRST, before any routes or routers
# Open CORS completely to avoid any blocking issues
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers AFTER middleware is set up
app.include_router(user_management_router)
app.include_router(password_reset_router)
app.include_router(pipeline_router)
app.include_router(lookup_router)
app.include_router(time_materials_router)


# Global exception handler to ensure CORS headers on errors
@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    return JSONResponse(
        status_code=500,
        content={"detail": str(exc)},
        headers={
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "*",
        },
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


def _migrate_add_columns() -> None:
    """Add columns that create_all() won't add to existing tables."""
    if engine is None:
        return
    insp = inspect(engine)
    
    is_sqlite = str(engine.url).startswith("sqlite")
    with engine.begin() as conn:
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
            
            # Create index for ticket_number if it doesn't exist
            indexes = {idx["name"] for idx in insp.get_indexes("spray_records")}
            if "idx_spray_records_ticket_number" not in indexes:
                conn.execute(text("CREATE INDEX idx_spray_records_ticket_number ON spray_records(ticket_number)"))


def get_site_or_404(db: Session, site_id: int) -> Site:
    site = (
        db.query(Site)
        .options(joinedload(Site.updates))
        .options(joinedload(Site.spray_records))
        .filter(Site.id == site_id)
        .first()
    )
    if site is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Site not found")
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
    """Get the next ticket number from the sequence."""
    result = db.execute(text("SELECT nextval('ticket_seq')"))
    seq_value = result.scalar()
    return {"ticket_number": f"T{seq_value:06d}"}


@app.get("/api/sync-status")
def sync_status(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """Return lightweight sync status to reduce bandwidth usage."""
    # Get max updated_at timestamps
    sites_updated = db.execute(text("SELECT MAX(updated_at) FROM sites WHERE deleted_at IS NULL")).scalar()
    pipelines_updated = db.execute(text("SELECT MAX(updated_at) FROM pipelines WHERE deleted_at IS NULL")).scalar()
    spray_records_updated = db.execute(text("SELECT MAX(created_at) FROM site_spray_records")).scalar()
    
    # Get pending counts for admins
    pending_sites_count = 0
    pending_pipelines_count = 0
    if current_user.role in (RoleEnum.admin, RoleEnum.office):
        pending_sites_count = db.query(Site).filter(
            Site.approval_state == ApprovalState.pending_review,
            Site.deleted_at.is_(None)
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
        "pending_sites_count": pending_sites_count,
        "pending_pipelines_count": pending_pipelines_count,
    }


@app.get("/api/sites", response_model=list[SiteRead])
def list_sites(
    search: str | None = Query(default=None),
    client: str | None = Query(default=None),
    area: str | None = Query(default=None),
    approval_state: ApprovalState | None = Query(default=None),
    pin_type: PinType | None = Query(default=None),
    site_status: SiteStatus | None = Query(default=None, alias="status"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[SiteRead]:
    query = db.query(Site).options(
        joinedload(Site.updates),
        joinedload(Site.spray_records),
        joinedload(Site.created_by_user),
        joinedload(Site.approved_by_user),
        joinedload(Site.last_inspected_by_user)
    ).filter(Site.deleted_at.is_(None)).order_by(Site.updated_at.desc())

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
    return [SiteRead.model_validate(site) for site in sites]


@app.get("/api/sites/{site_id}", response_model=SiteRead)
def get_site(
    site_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> SiteRead:
    site = get_site_or_404(db, site_id)
    return SiteRead.model_validate(site)


@app.get(
    "/api/pending-sites",
    response_model=list[SiteRead],
    dependencies=[Depends(require_roles(RoleEnum.admin, RoleEnum.office))],
)
def pending_sites(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[SiteRead]:
    sites = (
        db.query(Site)
        .options(joinedload(Site.updates))
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
    created_at = datetime.utcnow()
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
        last_inspected_at=created_at if payload.status == SiteStatus.inspected else None,
    )
    
    # Only set created_by_user_id if user exists in local DB to avoid FK constraint
    if current_user.id:
        local_user = db.query(User).filter(User.id == current_user.id).first()
        if local_user:
            site.created_by_user_id = current_user.id
    
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
    dependencies=[Depends(require_roles(RoleEnum.admin))],
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


@app.get("/api/sites/{site_id}/spray", response_model=list[SiteSprayRecordSummary])
def list_site_spray_records(
    site_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List spray records for a site (summary — no lease_sheet_data)."""
    get_site_or_404(db, site_id)
    q = db.query(SiteSprayRecord).filter(SiteSprayRecord.site_id == site_id)
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
    from app.dropbox_integration import upload_pdf_to_dropbox, upload_photo_to_dropbox, build_pdf_path, build_photo_path

    site = get_site_or_404(db, site_id)
    
    user_id = None
    if current_user.id:
        local_user = db.query(User).filter(User.id == current_user.id).first()
        if local_user:
            user_id = current_user.id

    user_name = getattr(current_user, 'name', None) or (current_user.email.split('@')[0].title() if current_user.email else None)

    # Only assign a ticket number for actual spray records (not issue/avoided)
    ticket_number = None
    if not payload.is_avoided:
        ticket_number = payload.ticket_number
        if not ticket_number:
            result = db.execute(text("SELECT nextval('ticket_seq')"))
            seq_value = result.scalar()
            ticket_number = f"T{seq_value:06d}"

    # Handle Dropbox uploads
    pdf_url = None
    photo_urls = []

    if payload.lease_sheet_data:
        lease_sheet_data = payload.lease_sheet_data.copy()
        lease_sheet_data['ticket_number'] = ticket_number

        # Upload frontend-generated PDF if provided
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
                pdf_url = upload_pdf_to_dropbox(pdf_content, pdf_path)
            except Exception as e:
                print(f"Error uploading PDF: {e}")

        # Upload photos if present
        if lease_sheet_data.get('photos'):
            for i, photo_data in enumerate(lease_sheet_data.get('photos', [])):
                try:
                    photo_content = base64.b64decode(photo_data.get('data', ''))
                    photo_path = build_photo_path(ticket_number, i + 1)
                    photo_url = upload_photo_to_dropbox(photo_content, photo_path)
                    if photo_url:
                        photo_urls.append(photo_url)
                except Exception as e:
                    print(f"Error uploading photo {i+1}: {e}")

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
    )
    db.add(record)
    
    # Auto-update site status if marking as sprayed or issue
    site.status = SiteStatus.issue if payload.is_avoided else SiteStatus.inspected
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


@app.delete("/api/site-spray-records/{record_id}", status_code=204)
def delete_site_spray_record(
    record_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_roles(RoleEnum.admin, RoleEnum.office)),
):
    """Delete a site spray record."""
    record = db.query(SiteSprayRecord).filter(SiteSprayRecord.id == record_id).first()
    if not record:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Site spray record not found")
    
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
    if current_user.role not in (RoleEnum.admin, RoleEnum.office):
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

    db.commit()
    db.refresh(record)
    return SiteSprayRecordRead.model_validate(record)


@app.get("/api/recent-submissions", response_model=list[RecentSubmissionRead])
def list_recent_submissions(
    search: str = Query(default=None),
    limit: int = Query(default=50, le=200),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List recent lease sheet submissions with search."""
    q = (
        db.query(
            SiteSprayRecord,
            Site.lsd.label('site_lsd'),
            Site.client.label('site_client'),
            Site.area.label('site_area'),
        )
        .join(Site, SiteSprayRecord.site_id == Site.id)
        .filter(SiteSprayRecord.lease_sheet_data.isnot(None))
    )

    if search:
        search_term = f"%{search}%"
        q = q.filter(
            or_(
                SiteSprayRecord.ticket_number.ilike(search_term),
                SiteSprayRecord.sprayed_by_name.ilike(search_term),
                Site.client.ilike(search_term),
                Site.area.ilike(search_term),
                Site.lsd.ilike(search_term),
            )
        )

    rows = q.order_by(SiteSprayRecord.created_at.desc()).limit(limit).all()

    # Build the summary view without lease_sheet_data — the PDF preview
    # fetches the real Dropbox PDF via /api/pdf-proxy, and the edit flow
    # fetches the full row via /api/site-spray-records/{id}.
    results = []
    for record, site_lsd, site_client, site_area in rows:
        data = SiteSprayRecordSummary.model_validate(record).model_dump()
        data['site_lsd'] = site_lsd
        data['site_client'] = site_client
        data['site_area'] = site_area
        results.append(RecentSubmissionRead(**data))
    return results


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
    if payload.status == SiteStatus.inspected:
        site.last_inspected_at = datetime.utcnow()
        # Store user ID, email, and name who inspected
        print(f"[DEBUG] Storing inspection data - User ID: {current_user.id}, Email: {current_user.email}, Name: {current_user.name}")
        if current_user.id and current_user.id > 0:
            # Only set FK if user exists in local DB
            local_user = db.query(User).filter(User.id == current_user.id).first()
            if local_user:
                site.last_inspected_by_user_id = current_user.id
        if current_user.email:
            site.last_inspected_by_email = current_user.email
            print(f"[DEBUG] Set last_inspected_by_email to {current_user.email}")
        if current_user.name:
            site.last_inspected_by_name = current_user.name
            print(f"[DEBUG] Set last_inspected_by_name to {current_user.name}")
        else:
            print(f"[DEBUG] User name is null/empty!")

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
    dependencies=[Depends(require_roles(RoleEnum.admin, RoleEnum.office))],
)
def delete_site(
    site_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> None:
    print(f"[DEBUG] delete_site called for site_id: {site_id} by user: {current_user.email}")
    site = get_site_or_404(db, site_id)
    print(f"[DEBUG] Found site: {site.id}, marking as deleted")
    site.deleted_at = datetime.utcnow()
    # Only set deleted_by_user_id if user exists in local DB to avoid FK constraint
    if current_user.id:
        # Check if user exists in local database
        local_user = db.query(User).filter(User.id == current_user.id).first()
        if local_user:
            site.deleted_by_user_id = current_user.id
    site.updated_at = datetime.utcnow()
    db.commit()
    print(f"[DEBUG] Site {site_id} marked as deleted successfully")


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
    dependencies=[Depends(require_roles(RoleEnum.admin, RoleEnum.office))],
)
def update_site_approval(
    site_id: int,
    payload: SiteApprovalUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> SiteRead:
    site = get_site_or_404(db, site_id)

    # Only set approved_by_user_id if user exists in local DB to avoid FK constraint
    if current_user.id:
        local_user = db.query(User).filter(User.id == current_user.id).first()
        if local_user:
            site.approved_by_user_id = current_user.id
    site.updated_at = datetime.utcnow()

    if payload.approval_state == ApprovalState.approved:
        site.approval_state = ApprovalState.approved
        if site.pending_pin_type is not None:
            site.pin_type = site.pending_pin_type
            site.pending_pin_type = None
    elif payload.approval_state == ApprovalState.rejected:
        # If this is a new pin (field_added source) that was never approved, delete it
        if site.source == "field_added" and site.approval_state == ApprovalState.pending_review:
            db.delete(site)
            db.commit()
            return SiteRead.model_validate(site)  # Return the deleted site for frontend handling
        else:
            # Revert to approved (previous normal state) and discard pending changes
            site.approval_state = ApprovalState.approved
            site.pending_pin_type = None

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
    dependencies=[Depends(require_roles(RoleEnum.admin, RoleEnum.office))],
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


@app.post(
    "/api/sites/{site_id}/restore",
    response_model=SiteRead,
    dependencies=[Depends(require_roles(RoleEnum.admin, RoleEnum.office))],
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
            return StreamingResponse(
                iter([resp.content]),
                media_type="application/pdf",
                headers={"Content-Disposition": "inline; filename=lease_sheet.pdf"},
            )
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Timeout fetching PDF from Dropbox")
    except Exception as e:
        print(f"[PDF_PROXY] Error: {type(e).__name__}: {e}")
        raise HTTPException(status_code=502, detail="Failed to fetch PDF")