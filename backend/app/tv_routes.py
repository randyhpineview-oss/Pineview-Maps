"""Operations TV dashboard endpoints (read-only).

A single router, ``tv_router``, gated to admin / office / tv roles. It powers
both:

  * the dedicated ``tv`` kiosk account (always-on office display), and
  * the admin/office "Operations TV" overlay (opened from their own login).

Two endpoints, both pure reads — nothing here mutates state, so even the
least-privileged ``tv`` role is safe to admit:

  * GET /api/tv/checkin-overview
        Delegates to the existing check-ins overview logic (one row per
        worker with an active shift or truck assignment, sorted worst-tier
        first). Reuses ``checkin_routes.get_overview`` verbatim so the TV
        board and the admin Check-ins Dashboard never diverge.

  * GET /api/tv/stats?day=YYYY-MM-DD
        Site-status breakdown (for the inspection-progress donut) plus
        today's throughput counts (lease sheets / T&M tickets / hydroseed
        records). The ``day`` query param is the CLIENT's local date so the
        "today" window is timezone-correct regardless of server TZ; it
        falls back to the server's UTC date when omitted.
"""

from datetime import date as date_type, datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.auth import require_roles
from app.checkin_routes import OverviewEntry, get_overview
from app.database import get_db
from app.models import (
    ApprovalState,
    HydroseedDailyRecord,
    PinType,
    RoleEnum,
    Site,
    SiteSprayRecord,
    SiteStatus,
    TimeMaterialsTicket,
)
from app.pipeline_models import Pipeline

# Pin types that represent an actual inspection site. Water sources and
# quad/access points are reference markers, not sites to inspect, so they
# are excluded from the inspection-progress donut.
INSPECTABLE_PIN_TYPES = (PinType.lsd, PinType.reclaimed)

# Admin + office can open the overlay from their own login; tv is the
# dedicated kiosk account. crew_lead is intentionally excluded — the
# TV board is an office-overview tool.
tv_router = APIRouter(
    prefix="/api/tv",
    tags=["tv"],
    dependencies=[
        Depends(require_roles(RoleEnum.admin, RoleEnum.office, RoleEnum.tv))
    ],
)


# ── Schemas ──────────────────────────────────────────────────────────


class SiteStatusBreakdown(BaseModel):
    not_inspected: int = 0
    in_progress: int = 0
    inspected: int = 0
    issue: int = 0
    issue_not_inspected: int = 0
    total: int = 0


class ThroughputCounts(BaseModel):
    lease_sheets: int = 0
    tm_tickets: int = 0
    hydroseed: int = 0


class TVStatsResponse(BaseModel):
    day: str
    site_status: SiteStatusBreakdown
    throughput: ThroughputCounts


# ── Helpers ──────────────────────────────────────────────────────────


def _resolve_day(day: Optional[str]) -> date_type:
    """Parse the client's local YYYY-MM-DD, falling back to UTC today.

    Never raises on a malformed value — a bad query param simply degrades
    to the server's date rather than 500-ing a wall display.
    """
    if day:
        try:
            return date_type.fromisoformat(day)
        except (ValueError, TypeError):
            pass
    return datetime.utcnow().date()


# ── Endpoints ────────────────────────────────────────────────────────


@tv_router.get("/checkin-overview", response_model=list[OverviewEntry])
def tv_checkin_overview(
    day: Optional[str] = Query(
        default=None, description="Client local date YYYY-MM-DD for the checked-out window"
    ),
    db: Session = Depends(get_db),
) -> list[OverviewEntry]:
    """Same payload as the admin Check-ins Dashboard Overview tab, plus
    workers who CHECKED OUT earlier today (greyed, sorted last) so the
    board shows who was on today even after they end their shift."""
    return get_overview(db=db, include_ended_day=_resolve_day(day))


@tv_router.get("/stats", response_model=TVStatsResponse)
def tv_stats(
    day: Optional[str] = Query(
        default=None, description="Client local date YYYY-MM-DD for the throughput window"
    ),
    db: Session = Depends(get_db),
) -> TVStatsResponse:
    target_day = _resolve_day(day)
    day_start = datetime(target_day.year, target_day.month, target_day.day)
    day_end = day_start + timedelta(days=1)

    # ── Inspection-progress breakdown ────────────────────────────────
    # Only real inspection sites count: LSD/reclaimed pins + pipelines.
    # Water + quad/access pins are reference markers, not inspected.
    # Mirror the default /api/sites visibility filter: approved, not
    # soft-deleted, not hidden.
    breakdown = SiteStatusBreakdown()

    def _add(key: str, count: int) -> None:
        if count <= 0:
            return
        if hasattr(breakdown, key):
            setattr(breakdown, key, getattr(breakdown, key) + count)
        breakdown.total += count

    site_rows = (
        db.query(Site.status, func.count(Site.id))
        .filter(
            Site.approval_state == ApprovalState.approved,
            Site.deleted_at.is_(None),
            Site.is_hidden.is_(False),
            Site.pin_type.in_(INSPECTABLE_PIN_TYPES),
        )
        .group_by(Site.status)
        .all()
    )
    for status_value, count in site_rows:
        # status_value is a SiteStatus enum (or its .value string depending
        # on the driver); normalize to the plain string key.
        key = status_value.value if isinstance(status_value, SiteStatus) else str(status_value)
        _add(key, int(count))

    # Pipelines only carry a two-state status (sprayed / not_sprayed), so
    # fold them into the matching donut buckets.
    pipeline_rows = (
        db.query(Pipeline.status, func.count(Pipeline.id))
        .filter(
            Pipeline.approval_state == "approved",
            Pipeline.deleted_at.is_(None),
        )
        .group_by(Pipeline.status)
        .all()
    )
    for status_value, count in pipeline_rows:
        key = "inspected" if str(status_value) == "sprayed" else "not_inspected"
        _add(key, int(count))

    # ── Today's throughput ───────────────────────────────────────────
    # spray_date is a DateTime → use a half-open range. The T&M and
    # hydroseed date columns are plain Date → direct equality.
    lease_sheets = (
        db.query(func.count(SiteSprayRecord.id))
        .filter(
            SiteSprayRecord.spray_date >= day_start,
            SiteSprayRecord.spray_date < day_end,
            SiteSprayRecord.deleted_at.is_(None),
        )
        .scalar()
        or 0
    )
    tm_tickets = (
        db.query(func.count(TimeMaterialsTicket.id))
        .filter(
            TimeMaterialsTicket.spray_date == target_day,
            TimeMaterialsTicket.deleted_at.is_(None),
        )
        .scalar()
        or 0
    )
    hydroseed = (
        db.query(func.count(HydroseedDailyRecord.id))
        .filter(
            HydroseedDailyRecord.work_date == target_day,
            HydroseedDailyRecord.deleted_at.is_(None),
        )
        .scalar()
        or 0
    )

    return TVStatsResponse(
        day=target_day.isoformat(),
        site_status=breakdown,
        throughput=ThroughputCounts(
            lease_sheets=int(lease_sheets),
            tm_tickets=int(tm_tickets),
            hydroseed=int(hydroseed),
        ),
    )
