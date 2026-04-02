from datetime import datetime

from fastapi import Depends, FastAPI, File, HTTPException, Query, Request, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import inspect, or_, text
from sqlalchemy.orm import Session, joinedload

from app.auth import get_current_user, require_roles, seed_demo_users
from app.config import get_settings
from app.database import Base, SessionLocal, engine, get_db
from app.kml_import import parse_kml_file
from app.user_management import router as user_management_router
from app.models import ApprovalState, PinType, RoleEnum, Site, SiteStatus, SiteUpdate, User
from app.schemas import (
    BulkResetRequest,
    BulkResetResponse,
    KmlImportResponse,
    SessionResponse,
    SiteAdminUpdate,
    SiteApprovalUpdate,
    SiteCreate,
    SiteQuickEdit,
    SiteRead,
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
        return  # Production mode: skip migrations
    insp = inspect(engine)
    if not insp.has_table("sites"):
        return
    existing = {col["name"] for col in insp.get_columns("sites")}
    is_sqlite = str(engine.url).startswith("sqlite")
    with engine.begin() as conn:
        if "deleted_at" not in existing:
            conn.execute(text("ALTER TABLE sites ADD COLUMN deleted_at TIMESTAMP"))
        if "deleted_by_user_id" not in existing:
            if is_sqlite:
                conn.execute(text("ALTER TABLE sites ADD COLUMN deleted_by_user_id INTEGER"))
            else:
                conn.execute(text("ALTER TABLE sites ADD COLUMN deleted_by_user_id INTEGER REFERENCES users(id)"))


def get_site_or_404(db: Session, site_id: int) -> Site:
    site = (
        db.query(Site)
        .options(joinedload(Site.updates))
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
    query = db.query(Site).options(joinedload(Site.updates)).filter(Site.deleted_at.is_(None)).order_by(Site.updated_at.desc())

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
        created_by_user_id=current_user.id if current_user.id else None,
    )
    db.add(site)
    db.flush()
    db.add(
        SiteUpdate(
            site_id=site.id,
            status=payload.status,
            note="Initial submission",
            created_by_user_id=current_user.id if current_user.id else None,
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

    update = SiteUpdate(
        site_id=site.id,
        status=payload.status,
        note=payload.note,
        created_by_user_id=current_user.id if current_user.id else None,
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
    site = get_site_or_404(db, site_id)
    site.deleted_at = datetime.utcnow()
    site.deleted_by_user_id = current_user.id if current_user.id else None
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
    dependencies=[Depends(require_roles(RoleEnum.admin, RoleEnum.office))],
)
def update_site_approval(
    site_id: int,
    payload: SiteApprovalUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> SiteRead:
    site = get_site_or_404(db, site_id)

    site.approved_by_user_id = current_user.id if current_user.id else None
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