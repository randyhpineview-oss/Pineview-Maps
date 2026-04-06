from datetime import datetime
import json
import math

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from sqlalchemy.orm import Session, joinedload

from app.auth import get_current_user, require_roles
from app.database import get_db
from app.kml_pipeline_import import parse_pipeline_kml, simplify_coordinates, _total_length_km
from app.models import RoleEnum, User
from app.pipeline_models import Pipeline, PipelineApprovalState, PipelineStatus, SprayRecord
from app.pipeline_schemas import (
    PipelineApprovalUpdate,
    PipelineBulkResetRequest,
    PipelineCreate,
    PipelineImportResponse,
    PipelineListRead,
    PipelineRead,
    PipelineUpdate,
    SprayRecordCreate,
    SprayRecordRead,
)

router = APIRouter(prefix="/api", tags=["pipelines"])


def _get_pipeline_or_404(db: Session, pipeline_id: int) -> Pipeline:
    pipeline = db.query(Pipeline).filter(Pipeline.id == pipeline_id, Pipeline.deleted_at.is_(None)).first()
    if not pipeline:
        raise HTTPException(status_code=404, detail="Pipeline not found")
    return pipeline


@router.post("/pipelines/import", response_model=PipelineImportResponse)
async def import_pipeline_kml(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_roles(RoleEnum.admin, RoleEnum.office)),
):
    """Import pipelines from a KML or KMZ file."""
    contents = await file.read()
    filename = file.filename or "unknown.kml"

    try:
        parsed = parse_pipeline_kml(contents, filename)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to parse file: {str(e)}")

    if not parsed:
        raise HTTPException(status_code=400, detail="No pipeline LineStrings found in file")

    created_pipelines = []
    for data in parsed:
        # Check if user exists locally for FK
        user_id = None
        if current_user.id:
            local_user = db.query(User).filter(User.id == current_user.id).first()
            if local_user:
                user_id = current_user.id

        pipeline = Pipeline(
            name=data["name"],
            client=data["client"],
            area=data["area"],
            coordinates=data["coordinates"],
            original_point_count=data["original_point_count"],
            simplified_point_count=data["simplified_point_count"],
            total_length_km=data["total_length_km"],
            status="not_sprayed",
            approval_state="approved",
            source=data["source"],
            source_name=data["source_name"],
            pipeline_metadata=json.loads(data["metadata"]) if data["metadata"] else None,
            created_by_user_id=user_id,
        )
        db.add(pipeline)
        db.flush()
        created_pipelines.append(pipeline)

    db.commit()
    for p in created_pipelines:
        db.refresh(p)

    return PipelineImportResponse(
        imported_count=len(created_pipelines),
        pipelines=[PipelineListRead.model_validate(p) for p in created_pipelines],
    )


@router.get("/pipelines", response_model=list[PipelineListRead])
def list_pipelines(
    client: str | None = Query(None),
    area: str | None = Query(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List all non-deleted pipelines, optionally filtered."""
    q = db.query(Pipeline).options(joinedload(Pipeline.spray_records)).filter(Pipeline.deleted_at.is_(None))
    if client:
        q = q.filter(Pipeline.client == client)
    if area:
        q = q.filter(Pipeline.area == area)
    q = q.order_by(Pipeline.created_at.desc())
    return [PipelineListRead.model_validate(p) for p in q.all()]


@router.get("/pending-pipelines", response_model=list[PipelineListRead])
def list_pending_pipelines(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_roles(RoleEnum.admin, RoleEnum.office)),
):
    """List pipelines pending approval."""
    pipelines = (
        db.query(Pipeline)
        .filter(Pipeline.deleted_at.is_(None), Pipeline.approval_state == "pending_review")
        .order_by(Pipeline.created_at.desc())
        .all()
    )
    return [PipelineListRead.model_validate(p) for p in pipelines]


@router.get("/pipelines/{pipeline_id}", response_model=PipelineRead)
def get_pipeline(
    pipeline_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get a single pipeline with its spray records."""
    pipeline = _get_pipeline_or_404(db, pipeline_id)
    return PipelineRead.model_validate(pipeline)


@router.patch("/pipelines/{pipeline_id}", response_model=PipelineListRead)
def update_pipeline(
    pipeline_id: int,
    payload: PipelineUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_roles(RoleEnum.admin, RoleEnum.office)),
):
    """Update pipeline metadata."""
    pipeline = _get_pipeline_or_404(db, pipeline_id)
    if payload.name is not None:
        pipeline.name = payload.name
    if payload.client is not None:
        pipeline.client = payload.client
    if payload.area is not None:
        pipeline.area = payload.area
    pipeline.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(pipeline)
    return PipelineListRead.model_validate(pipeline)


@router.delete("/pipelines/{pipeline_id}", status_code=204)
def delete_pipeline(
    pipeline_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_roles(RoleEnum.admin, RoleEnum.office)),
):
    """Soft-delete a pipeline."""
    pipeline = _get_pipeline_or_404(db, pipeline_id)
    pipeline.deleted_at = datetime.utcnow()
    pipeline.updated_at = datetime.utcnow()
    db.commit()


@router.post("/pipelines/{pipeline_id}/approval", response_model=PipelineListRead)
def update_pipeline_approval(
    pipeline_id: int,
    payload: PipelineApprovalUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_roles(RoleEnum.admin, RoleEnum.office)),
):
    """Approve or reject a pipeline."""
    pipeline = _get_pipeline_or_404(db, pipeline_id)
    pipeline.approval_state = payload.approval_state
    if payload.name is not None:
        pipeline.name = payload.name
    if payload.client is not None:
        pipeline.client = payload.client
    if payload.area is not None:
        pipeline.area = payload.area
    pipeline.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(pipeline)
    return PipelineListRead.model_validate(pipeline)


@router.post("/pipelines", response_model=PipelineListRead)
def create_pipeline(
    payload: PipelineCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Create a pipeline from drawn coordinates (via + button on map)."""
    if len(payload.coordinates) < 2:
        raise HTTPException(status_code=400, detail="Pipeline must have at least 2 points")

    coords = [[c[0], c[1]] for c in payload.coordinates]
    original_count = len(coords)
    simplified = simplify_coordinates(coords)
    length_km = _total_length_km(coords)

    # Workers get pending_review, admin/office get approved
    is_admin = current_user.role in (RoleEnum.admin, RoleEnum.office)
    approval = "approved" if is_admin else "pending_review"

    user_id = None
    if current_user.id:
        local_user = db.query(User).filter(User.id == current_user.id).first()
        if local_user:
            user_id = current_user.id

    pipeline = Pipeline(
        name=payload.name,
        client=payload.client,
        area=payload.area,
        coordinates=simplified,
        original_point_count=original_count,
        simplified_point_count=len(simplified),
        total_length_km=length_km,
        status="not_sprayed",
        approval_state=approval,
        source="field_drawn",
        created_by_user_id=user_id,
    )
    db.add(pipeline)
    db.commit()
    db.refresh(pipeline)
    return PipelineListRead.model_validate(pipeline)


# ── Spray Records ──

@router.post("/pipelines/{pipeline_id}/spray", response_model=SprayRecordRead)
def create_spray_record(
    pipeline_id: int,
    payload: SprayRecordCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Record a sprayed section of a pipeline."""
    pipeline = _get_pipeline_or_404(db, pipeline_id)

    user_id = None
    if current_user.id:
        local_user = db.query(User).filter(User.id == current_user.id).first()
        if local_user:
            user_id = current_user.id

    user_name = getattr(current_user, 'name', None) or (current_user.email.split('@')[0].title() if current_user.email else None)

    record = SprayRecord(
        pipeline_id=pipeline_id,
        start_fraction=min(payload.start_fraction, payload.end_fraction),
        end_fraction=max(payload.start_fraction, payload.end_fraction),
        spray_date=payload.spray_date,
        sprayed_by_user_id=user_id,
        sprayed_by_name=user_name,
        notes=payload.notes,
    )
    db.add(record)

    # Check if pipeline is now 100% sprayed
    db.flush()
    _update_pipeline_spray_status(db, pipeline)

    db.commit()
    db.refresh(record)
    return SprayRecordRead.model_validate(record)


@router.get("/pipelines/{pipeline_id}/spray", response_model=list[SprayRecordRead])
def list_spray_records(
    pipeline_id: int,
    spray_date: str | None = Query(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List spray records for a pipeline, optionally filtered by date."""
    _get_pipeline_or_404(db, pipeline_id)
    q = db.query(SprayRecord).filter(SprayRecord.pipeline_id == pipeline_id)
    if spray_date:
        from datetime import date as date_type
        try:
            d = date_type.fromisoformat(spray_date)
            q = q.filter(SprayRecord.spray_date == d)
        except ValueError:
            pass
    return [SprayRecordRead.model_validate(r) for r in q.order_by(SprayRecord.created_at.desc()).all()]


@router.delete("/spray-records/{record_id}", status_code=204)
def delete_spray_record(
    record_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_roles(RoleEnum.admin, RoleEnum.office)),
):
    """Delete a spray record."""
    record = db.query(SprayRecord).filter(SprayRecord.id == record_id).first()
    if not record:
        raise HTTPException(status_code=404, detail="Spray record not found")
    pipeline_id = record.pipeline_id
    db.delete(record)
    db.flush()

    # Update pipeline status
    pipeline = db.query(Pipeline).filter(Pipeline.id == pipeline_id).first()
    if pipeline:
        _update_pipeline_spray_status(db, pipeline)

    db.commit()


# ── Admin bulk operations ──

@router.post("/admin/pipelines/bulk-reset")
def bulk_reset_pipelines(
    payload: PipelineBulkResetRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_roles(RoleEnum.admin, RoleEnum.office)),
):
    """Batch mark pipelines as not sprayed by deleting spray records."""
    q = db.query(Pipeline).filter(Pipeline.deleted_at.is_(None))

    if payload.pipeline_ids:
        q = q.filter(Pipeline.id.in_(payload.pipeline_ids))
    else:
        if payload.client:
            q = q.filter(Pipeline.client == payload.client)
        if payload.area:
            q = q.filter(Pipeline.area == payload.area)
        if not payload.client and not payload.area:
            raise HTTPException(status_code=400, detail="Must specify client, area, or pipeline_ids")

    pipelines = q.all()
    reset_count = 0
    for pipeline in pipelines:
        # Delete all spray records
        db.query(SprayRecord).filter(SprayRecord.pipeline_id == pipeline.id).delete()
        pipeline.status = "not_sprayed"
        pipeline.updated_at = datetime.utcnow()
        reset_count += 1

    db.commit()
    return {"reset_count": reset_count}


def _update_pipeline_spray_status(db: Session, pipeline: Pipeline):
    """Update pipeline status based on spray coverage."""
    records = db.query(SprayRecord).filter(SprayRecord.pipeline_id == pipeline.id).all()
    if not records:
        pipeline.status = "not_sprayed"
        return

    # Merge overlapping spray ranges
    ranges = sorted([(r.start_fraction, r.end_fraction) for r in records])
    merged = [ranges[0]]
    for start, end in ranges[1:]:
        if start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))

    total_coverage = sum(end - start for start, end in merged)
    # Consider fully sprayed if coverage >= 95%
    if total_coverage >= 0.95:
        pipeline.status = "sprayed"
    else:
        pipeline.status = "not_sprayed"
