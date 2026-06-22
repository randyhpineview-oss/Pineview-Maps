"""Admin/office reporting dashboard endpoints.

Only ever hit when an admin/office user explicitly opens the Reports page and
clicks Generate/Download — there is NO background polling or preloading from
the frontend. Both endpoints below should be considered "dead" unless the
dashboard is open, so worker sessions never touch them and Supabase egress
stays at zero for 99% of users.

Two endpoints:
  • GET /api/admin/reports/spray-records/preview
        Returns JSON for the dashboard preview table (max 500 rows + a
        total_matched count). Small & fast — powers the UI only.

  • GET /api/admin/reports/spray-records/export.csv
        Streams CSV directly via StreamingResponse, one row at a time, using
        SQLAlchemy's yield_per so memory stays flat even for 100K+ row
        exports. No row cap.

Both share the same query logic, the same formatter, and the same T&M-style
row-derivation helpers already used to populate T&M tickets in
`time_materials_routes.py`, so the office's "T&M format" CSV output matches
what they see on a real T&M ticket — no drift between the two features.
"""
from __future__ import annotations

import csv
import heapq
import io
from datetime import date as date_type, datetime
from typing import Iterable, Iterator, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from fastapi.responses import StreamingResponse
from sqlalchemy import and_, or_, text
from sqlalchemy.orm import Session

from app.auth import require_roles
from app.database import get_db
from app.models import RoleEnum, Site, SiteSprayRecord, User
from app.pipeline_models import Pipeline, SprayRecord
from app.time_materials_routes import (
    _herbicides_text,
    derive_roadside_row_from_spray_record,
    derive_row_from_spray_record,
)

router = APIRouter(prefix="/api/admin/reports", tags=["reports"])


# ── Column catalog ──────────────────────────────────────────────────────────
# Keys MUST match the frontend ReportsDashboard column picker 1:1. The
# `header` is what lands in the CSV / preview table header row. Extraction
# happens in `_build_report_row()` below, which runs format preferences
# through the helpers at the bottom of this file.
# Tank mix recipe — per 400L tank. Mirrors the chart hardcoded in
# frontend/src/components/TankMixChartOverlay.jsx. Keys are lowercased
# herbicide names as they appear in lease_sheet_data.herbicidesUsed (which
# come straight from the `herbicides` lookup table, e.g. 'Glyphosate',
# 'MCPA', 'Tordon', 'Par III'). For a row using `total_liters` of mix the
# amount of concentrate used is `total_liters * rate / 400`, in `unit`.
TANK_MIX_RECIPES: dict[str, dict] = {
    "glyphosate":  {"rate": 5.0,  "unit": "L", "label": "Glyphosate"},
    "tordon":      {"rate": 0.75, "unit": "L", "label": "Tordon"},
    "mcpa":        {"rate": 0.75, "unit": "L", "label": "MCPA"},
    "escort":      {"rate": 16.0, "unit": "g", "label": "Escort"},
    "assure":      {"rate": 16.0, "unit": "g", "label": "Assure"},
    "par iii":     {"rate": 5.0,  "unit": "L", "label": "Par III"},
    "garlon":      {"rate": 7.0,  "unit": "L", "label": "Garlon"},
    "draft":       {"rate": 8.0,  "unit": "g", "label": "Draft"},
    "tracker xp":  {"rate": 2.5,  "unit": "L", "label": "Tracker XP"},
    "trillion":    {"rate": 10.0, "unit": "L", "label": "Trillion"},
}

# Per-herbicide concentrate column keys, derived from the recipe table so
# the frontend column picker stays 1:1 with the backend. Header includes
# the unit so the column itself can stay a bare number (Excel-summable).
_CONC_COLUMNS: dict[str, str] = {
    f"conc_{key.replace(' ', '_')}": f"{recipe['label']} ({recipe['unit']})"
    for key, recipe in TANK_MIX_RECIPES.items()
}

COLUMN_CATALOG: dict[str, str] = {
    "ticket_number":      "Ticket #",
    "source_type":        "Source",
    "lsd_or_pipeline":    "LSD / Pipeline",
    "customer":           "Customer",
    "area":               "Area",
    "spray_date":         "Date",
    "sprayed_by":         "Sprayed By",
    "applicators":        "Applicators",
    "herbicides":         "Herbicides",
    "noxious_weeds":      "Noxious Weeds",
    "location_types":     "Location Types",
    "main_site_type":     "Main Site Type",
    "total_liters":       "Total Liters",
    "total_area":         "Total Area",
    "total_distance_km":  "Total Distance (km)",
    "wind_direction":     "Wind Direction",
    "wind_speed_kmh":     "Wind Speed (km/h)",
    "temperature_c":      "Temperature (°C)",
    "roadside_km":        "Roadside Km",
    "roadside_liters":    "Roadside Liters",
    "roadside_herbicides": "Roadside Herbicides",
    "roadside_area_ha":   "Roadside Area (ha)",
    "notes":              "Notes",
    **_CONC_COLUMNS,
    "concentrate_amounts": "Concentrate Amounts",
}


def _concentrate_amount(herb_name: str, total_liters: Optional[float]) -> Optional[tuple[float, str]]:
    """Return (amount, unit) of concentrate used for one herbicide on one
    row, or None if the herbicide isn't in the recipe table or there's no
    tank volume to multiply against. Amount is in liters or grams per
    `TANK_MIX_RECIPES[*].unit`.
    """
    if total_liters is None or total_liters <= 0 or not herb_name:
        return None
    recipe = TANK_MIX_RECIPES.get(str(herb_name).strip().lower())
    if not recipe:
        return None
    amount = total_liters * recipe["rate"] / 400.0
    return amount, recipe["unit"]


def _fmt_concentrate_number(amount: float) -> str:
    """Plain number with up to 2 decimals, trailing zeros stripped — keeps
    cells Excel-summable. e.g. 5.0 → '5', 0.3125 → '0.31'."""
    s = f"{amount:.2f}".rstrip("0").rstrip(".")
    return s or "0"

DEFAULT_COLUMNS = [
    "ticket_number",
    "lsd_or_pipeline",
    "customer",
    "area",
    "spray_date",
    "sprayed_by",
    "herbicides",
    "total_liters",
    "total_area",
]

# ── Helpers ─────────────────────────────────────────────────────────────────

def _to_float(v) -> Optional[float]:
    try:
        return float(v) if v not in (None, "", "___") else None
    except (ValueError, TypeError):
        return None


def _guard_csv(value: str) -> str:
    """OWASP-recommended mitigation for Excel CSV-formula injection.

    Any cell whose value begins with `=`, `+`, `-`, or `@` gets prefixed with
    a single quote so Excel / Sheets treat it as text instead of evaluating
    it as a formula (protects against the `=HYPERLINK(...)`/`=cmd|...` class
    of attacks).
    """
    if value and value[0] in ("=", "+", "-", "@"):
        return "'" + value
    return value


def _fmt_herbicide_list(names: list, pcp_lookup: dict, fmt: str) -> str:
    """Format a list of herbicide names per the office's `herbicides_format`.

    Modes:
      • "pcp"     → "Roundup (PCP 12345); 2,4-D (PCP 67890)"
      • "names"   → "Roundup; 2,4-D"
      • "tm_count"→ "2 Herbicides"   (matches T&M sheet, capped at 3)
    """
    if not names:
        return ""
    if fmt == "tm_count":
        return _herbicides_text(names)
    if fmt == "names":
        return "; ".join(str(n) for n in names)
    # default / "pcp"
    parts: list[str] = []
    for n in names:
        key = str(n).strip().lower()
        pcp = pcp_lookup.get(key)
        parts.append(f"{n} (PCP {pcp})" if pcp else str(n))
    return "; ".join(parts)


def _fmt_date(d, fmt: str) -> str:
    if d is None:
        return ""
    if isinstance(d, datetime):
        d = d.date()
    if fmt == "local":
        # e.g. "Mar 14, 2025" — static format, no user-locale dependency.
        return d.strftime("%b %d, %Y")
    return d.isoformat()


def _fmt_area(area_ha: Optional[float], site_type: str, units: str) -> str:
    """Format the Total Area column.

    units:
      • "ha"   → hectares, 2 decimals. Pipeline/Roadside still rendered in km
                 because their underlying column stores km, not ha.
      • "m2"   → square meters (area_ha × 10 000). Pipeline/Roadside rendered
                 in km since converting km → m² would be meaningless.
      • "auto" → km for Pipeline/Roadside, ha otherwise. Matches the T&M
                 detail sheet's own unit logic at TMTicketDetailSheet.jsx:781.
      • "number" → bare number, no unit suffix. Lets the office sum the
                 column in Excel without stripping " ha" / " km" text first.
                 Pipeline/Roadside rows still carry km magnitude; header
                 stays generic ("Total Area") so the caller knows the
                 column may be mixed-unit.
    """
    if area_ha is None:
        return ""
    if units == "number":
        return f"{area_ha:.2f}"
    is_km = site_type in ("Pipeline", "Roadside", "Access Road")
    if is_km:
        return f"{area_ha:.2f} km"
    if units == "m2":
        return f"{area_ha * 10000:.0f} m²"
    return f"{area_ha:.2f} ha"


def _build_pcp_lookup(db: Session) -> dict:
    """Return { lowercased_name: pcp_number } for every active herbicide.

    Cached per request only — ~50 rows, 1-2 ms query, negligible."""
    try:
        result = db.execute(text(
            "SELECT name, pcp_number FROM herbicides "
            "WHERE is_active = TRUE AND pcp_number IS NOT NULL"
        ))
        return {str(row[0]).strip().lower(): row[1] for row in result}
    except Exception:
        # If the herbicides table isn't present (dev, fresh schema), fall
        # back to an empty lookup — names still render, just without PCP.
        return {}


# ── Row extraction ──────────────────────────────────────────────────────────

def _extract_context(record, is_pipeline: bool):
    """Return (source_type, lsd_or_pipeline, customer, area) for a record."""
    data = record.lease_sheet_data or {}
    if is_pipeline:
        pipeline = getattr(record, "pipeline", None)
        return (
            "Pipeline",
            data.get("lsdOrPipeline") or (pipeline.name if pipeline else "") or "",
            (pipeline.client if pipeline else "") or "",
            (pipeline.area if pipeline else "") or "",
        )
    site = getattr(record, "site", None)
    # External/standalone lease sheets live on hidden placeholder sites —
    # flag them as "External" in reports so admins can distinguish roadside
    # / off-map jobs from regular mapped sites.
    site_type = "External" if (site and getattr(site, "is_hidden", False)) else "Site"
    return (
        site_type,
        data.get("lsdOrPipeline") or (site.lsd if site else "") or "",
        (site.client if site else "") or "",
        (site.area if site else "") or "",
    )


def _iter_output_rows(record, is_pipeline: bool, split_roadside: bool) -> Iterator[dict]:
    """Yield one or two output dicts per spray record.

    When split_roadside=True AND the lease sheet has access-road work, the
    T&M row-derivation helpers peel off a companion "Roadside" row — exactly
    like the T&M ticket's Sites Treated table does.
    """
    data = record.lease_sheet_data or {}
    source_type, lsd_or_pipeline, customer, area = _extract_context(record, is_pipeline)

    if split_roadside:
        main = derive_row_from_spray_record(record)
        roadside = derive_roadside_row_from_spray_record(record)
        # Main row (site_type comes from the T&M helper so it can report
        # "Pipeline" when the lease sheet had isPipeline=True).
        yield {
            "_record": record,
            "_data": data,
            "_site_type_for_units": main.get("site_type") or source_type,
            "_is_roadside_row": False,
            "source_type": main.get("site_type") or source_type,
            "lsd_or_pipeline": main.get("location") or lsd_or_pipeline,
            "customer": customer,
            "area": area,
            "main_site_type": main.get("site_type") or "",
            "area_ha_for_render": _to_float(main.get("area_ha")),
            "total_liters": _to_float(main.get("liters_used")),
            "herbicides_source": data.get("herbicidesUsed") or [],
        }
        if roadside is not None:
            yield {
                "_record": record,
                "_data": data,
                "_site_type_for_units": "Access Road",
                "_is_roadside_row": True,
                "source_type": "Access Road",
                "lsd_or_pipeline": roadside.get("location") or lsd_or_pipeline,
                "customer": customer,
                "area": area,
                "main_site_type": "Access Road",
                "area_ha_for_render": _to_float(roadside.get("area_ha")),
                "total_liters": _to_float(roadside.get("liters_used")),
                "herbicides_source": data.get("roadsideHerbicides") or [],
            }
    else:
        main_site_type = data.get("mainSiteType") or ""
        site_type_for_units = main_site_type if main_site_type in ("Pipeline", "Roadside", "Access Road") else source_type
        area_val = _to_float(data.get("totalDistanceSprayed")) if main_site_type in ("Pipeline", "Roadside", "Access Road") else _to_float(data.get("areaTreated"))
        yield {
            "_record": record,
            "_data": data,
            "_site_type_for_units": site_type_for_units,
            "_is_roadside_row": False,
            "source_type": source_type,
            "lsd_or_pipeline": lsd_or_pipeline,
            "customer": customer,
            "area": area,
            "main_site_type": main_site_type,
            "area_ha_for_render": area_val,
            "total_liters": _to_float(data.get("totalLiters")),
            "herbicides_source": data.get("herbicidesUsed") or [],
        }


def _build_report_row(
    out: dict,
    *,
    columns: list[str],
    herbicides_format: str,
    area_units: str,
    date_format: str,
    weeds_format: str,
    pcp_lookup: dict,
) -> dict[str, str]:
    """Project an intermediate row (from _iter_output_rows) down to the
    exact column keys the client asked for, formatted per user prefs."""
    record = out["_record"]
    data = out["_data"]
    is_roadside_row = out["_is_roadside_row"]
    site_type_for_units = out["_site_type_for_units"]

    def col(key: str) -> str:
        if key == "ticket_number":
            return record.ticket_number or ""
        if key == "source_type":
            return out["source_type"]
        if key == "lsd_or_pipeline":
            return out["lsd_or_pipeline"] or ""
        if key == "customer":
            return out["customer"] or ""
        if key == "area":
            return out["area"] or ""
        if key == "spray_date":
            return _fmt_date(record.spray_date, date_format)
        if key == "sprayed_by":
            return record.sprayed_by_name or ""
        if key == "applicators":
            return "; ".join(data.get("applicators") or [])
        if key == "herbicides":
            # In split mode the Roadside output row pulls from
            # roadsideHerbicides; the main row pulls from herbicidesUsed.
            # In non-split mode herbicides_source is always herbicidesUsed.
            src = out["herbicides_source"]
            return _fmt_herbicide_list(src, pcp_lookup, herbicides_format)
        if key == "noxious_weeds":
            selected = data.get("noxiousWeedsSelected") or []
            custom = data.get("customWeeds") or []
            if weeds_format == "selected_only":
                items = selected
            else:
                # Drop the literal "Other" token when custom weeds replace it.
                items = [w for w in selected if str(w).strip().lower() != "other"] + list(custom)
            return "; ".join(str(w) for w in items)
        if key == "location_types":
            return "; ".join(data.get("locationTypes") or [])
        if key == "main_site_type":
            return out["main_site_type"] or ""
        if key == "total_liters":
            v = out["total_liters"]
            return "" if v is None else f"{v:g}"
        if key == "total_area":
            return _fmt_area(out["area_ha_for_render"], site_type_for_units, area_units)
        if key == "total_distance_km":
            v = _to_float(data.get("totalDistanceSprayed"))
            return "" if v is None else f"{v:g}"
        if key == "wind_direction":
            return "; ".join(data.get("windDirection") or [])
        if key == "wind_speed_kmh":
            v = _to_float(data.get("windSpeed"))
            return "" if v is None else f"{v:g}"
        if key == "temperature_c":
            v = _to_float(data.get("temperature"))
            return "" if v is None else f"{v:g}"
        if key == "roadside_km":
            v = _to_float(data.get("roadsideKm"))
            return "" if v is None else f"{v:g}"
        if key == "roadside_liters":
            v = _to_float(data.get("roadsideLiters"))
            return "" if v is None else f"{v:g}"
        if key == "roadside_herbicides":
            return _fmt_herbicide_list(
                data.get("roadsideHerbicides") or [], pcp_lookup, herbicides_format
            )
        if key == "roadside_area_ha":
            v = _to_float(data.get("roadsideAreaTreated"))
            return "" if v is None else f"{v:.2f}"
        if key == "notes":
            return record.notes or ""
        if key == "concentrate_amounts":
            # Inline summary across every recipe-matched herbicide on this
            # row, e.g. "Glyphosate: 0.31 L; MCPA: 0.05 L". Uses the same
            # herbicides_source as the Herbicides column so split mode's
            # Roadside row reports concentrates from roadsideHerbicides.
            parts: list[str] = []
            tl = out["total_liters"]
            for name in out["herbicides_source"] or []:
                pair = _concentrate_amount(name, tl)
                if pair is None:
                    continue
                amount, unit = pair
                recipe = TANK_MIX_RECIPES.get(str(name).strip().lower())
                label = (recipe or {}).get("label") or name
                parts.append(f"{label}: {_fmt_concentrate_number(amount)} {unit}")
            return "; ".join(parts)
        if key.startswith("conc_"):
            # Per-herbicide bare-number column. Header in COLUMN_CATALOG
            # already names the unit, so the cell stays summable in Excel.
            # Empty when this row didn't use that herbicide (or the recipe
            # is unknown / no tank volume).
            recipe_key = key[len("conc_"):].replace("_", " ")
            recipe = TANK_MIX_RECIPES.get(recipe_key)
            if not recipe:
                return ""
            target_label = recipe["label"].lower()
            tl = out["total_liters"]
            for name in out["herbicides_source"] or []:
                if str(name).strip().lower() != target_label:
                    continue
                pair = _concentrate_amount(name, tl)
                if pair is None:
                    return ""
                return _fmt_concentrate_number(pair[0])
            return ""
        return ""

    # Every cell gets passed through the formula-injection guard before it
    # leaves this function. Stringifies Nones / numbers so the caller never
    # has to care about type.
    return {key: _guard_csv(str(col(key) or "")) for key in columns}


# ── Totals ──────────────────────────────────────────────────────────────────

def _fold_totals_row(totals: dict, out: dict):
    """Accumulate year-end totals matching the 4 auto-populated office lines
    on a T&M ticket. Only meaningful when split_roadside=True, so the
    caller enforces that contract."""
    area_ha = out["area_ha_for_render"] or 0
    liters = out["total_liters"] or 0
    site_type = out["_site_type_for_units"]
    if site_type in ("Pipeline", "Roadside", "Access Road"):
        totals["pipeline_roadside_liters"] += liters
        return
    # Main row — bucket by herbicide count (1/2/3+, capped at 3).
    n = len(out["herbicides_source"] or [])
    if n <= 0:
        return
    bucket = min(n, 3)
    totals[f"m2_{bucket}_herb"] += area_ha * 10000


# ── Query building ──────────────────────────────────────────────────────────

def _build_queries(
    db: Session,
    *,
    start_date: date_type,
    end_date: date_type,
    customer: Optional[str],
    area: Optional[str],
    applicator: Optional[str],
    herbicide: Optional[str],
    include_avoided: bool,
):
    """Return (site_q, pipeline_q) filtered+ordered.

    Both queries eager-join their parent Site/Pipeline so the downstream
    formatter can read .site.lsd / .pipeline.name without a per-row lookup.
    """
    from sqlalchemy.orm import joinedload

    site_q = (
        db.query(SiteSprayRecord)
        .options(joinedload(SiteSprayRecord.site))
        .filter(
            SiteSprayRecord.deleted_at.is_(None),
            SiteSprayRecord.spray_date >= start_date,
            SiteSprayRecord.spray_date <= end_date,
        )
    )
    pipeline_q = (
        db.query(SprayRecord)
        .options(joinedload(SprayRecord.pipeline))
        .filter(
            SprayRecord.deleted_at.is_(None),
            SprayRecord.spray_date >= start_date,
            SprayRecord.spray_date <= end_date,
        )
    )
    if not include_avoided:
        site_q = site_q.filter(SiteSprayRecord.is_avoided.is_(False))
        pipeline_q = pipeline_q.filter(SprayRecord.is_avoided.is_(False))

    if customer or area:
        site_q = site_q.join(Site, SiteSprayRecord.site_id == Site.id)
        if customer:
            site_q = site_q.filter(Site.client == customer)
        if area:
            site_q = site_q.filter(Site.area == area)

    if customer or area:
        pipeline_q = pipeline_q.join(Pipeline, SprayRecord.pipeline_id == Pipeline.id)
        if customer:
            pipeline_q = pipeline_q.filter(Pipeline.client == customer)
        if area:
            pipeline_q = pipeline_q.filter(Pipeline.area == area)

    if applicator:
        # Applicator is inside lease_sheet_data.applicators (JSONB array of
        # strings). Postgres `?` operator checks for element presence.
        site_q = site_q.filter(
            text("site_spray_records.lease_sheet_data -> 'applicators' ? :ap").bindparams(ap=applicator)
        )
        pipeline_q = pipeline_q.filter(
            text("spray_records.lease_sheet_data -> 'applicators' ? :ap").bindparams(ap=applicator)
        )
    if herbicide:
        # Match in either herbicidesUsed OR roadsideHerbicides so the filter
        # catches access-road work too.
        site_q = site_q.filter(
            or_(
                text("site_spray_records.lease_sheet_data -> 'herbicidesUsed' ? :hb").bindparams(hb=herbicide),
                text("site_spray_records.lease_sheet_data -> 'roadsideHerbicides' ? :hb").bindparams(hb=herbicide),
            )
        )
        pipeline_q = pipeline_q.filter(
            or_(
                text("spray_records.lease_sheet_data -> 'herbicidesUsed' ? :hb").bindparams(hb=herbicide),
                text("spray_records.lease_sheet_data -> 'roadsideHerbicides' ? :hb").bindparams(hb=herbicide),
            )
        )

    # ASC order so heapq.merge below yields the full combined result set in
    # chronological order — matters for year-end reports where office wants
    # to read straight down the page.
    site_q = site_q.order_by(SiteSprayRecord.spray_date.asc(), SiteSprayRecord.id.asc())
    pipeline_q = pipeline_q.order_by(SprayRecord.spray_date.asc(), SprayRecord.id.asc())
    return site_q, pipeline_q


def _iter_merged_records(site_q, pipeline_q, *, chunk_size: int = 200) -> Iterator[tuple]:
    """Stream records from both tables in chronological order.

    Each yielded tuple is `(record, is_pipeline)`.
    Uses .all() to load rows into memory, avoiding PgBouncer transaction-mode cursor
    timeouts on Supabase, while utilizing `heapq.merge` with a tie-breaker.
    """
    site_records = site_q.all()
    pipeline_records = pipeline_q.all()

    def _site_key_iter():
        for r in site_records:
            # Yield (spray_date, id, is_pipeline, record)
            # Normalizing to date avoids comparison TypeErrors between datetime and date.
            d = r.spray_date.date() if hasattr(r.spray_date, "date") else r.spray_date
            yield (d, r.id, False, r)

    def _pipeline_key_iter():
        for r in pipeline_records:
            # Yield (spray_date, id, is_pipeline, record)
            # Normalizing to date avoids comparison TypeErrors between datetime and date.
            d = r.spray_date.date() if hasattr(r.spray_date, "date") else r.spray_date
            yield (d, r.id, True, r)

    for _d, _id, is_pipeline, record in heapq.merge(_site_key_iter(), _pipeline_key_iter()):
        yield record, is_pipeline


# ── Endpoints ───────────────────────────────────────────────────────────────

# A sane cap on the preview endpoint so the dashboard table never tries to
# render thousands of rows. The real export is the streaming CSV which has
# no cap.
PREVIEW_LIMIT = 500


@router.get(
    "/spray-records/preview",
    dependencies=[Depends(require_roles(RoleEnum.admin, RoleEnum.office))],
)
def preview_spray_records(
    start_date: date_type = Query(...),
    end_date: date_type = Query(...),
    customer: Optional[str] = Query(default=None),
    area: Optional[str] = Query(default=None),
    applicator: Optional[str] = Query(default=None),
    herbicide: Optional[str] = Query(default=None),
    include_avoided: bool = Query(default=False),
    split_roadside: bool = Query(default=False),
    columns: Optional[str] = Query(default=None, description="Comma-separated column keys"),
    herbicides_format: str = Query(default="pcp", pattern="^(pcp|names|tm_count)$"),
    area_units: str = Query(default="ha", pattern="^(ha|m2|auto|number)$"),
    date_format: str = Query(default="iso", pattern="^(iso|local)$"),
    weeds_format: str = Query(default="all", pattern="^(all|selected_only)$"),
    db: Session = Depends(get_db),
):
    """Small JSON payload used ONLY to render the preview table."""
    if end_date < start_date:
        raise HTTPException(status_code=400, detail="end_date must be >= start_date")

    selected_columns = _resolve_columns(columns)
    pcp_lookup = _build_pcp_lookup(db)

    site_q, pipeline_q = _build_queries(
        db,
        start_date=start_date,
        end_date=end_date,
        customer=customer,
        area=area,
        applicator=applicator,
        herbicide=herbicide,
        include_avoided=include_avoided,
    )

    # total_matched counts BASE spray records (not output rows), so admins
    # see the real dataset size regardless of whether split_roadside is on.
    total_matched = site_q.count() + pipeline_q.count()

    rows: list[dict[str, str]] = []
    for record, is_pipeline in _iter_merged_records(site_q, pipeline_q):
        for out in _iter_output_rows(record, is_pipeline, split_roadside):
            rows.append(_build_report_row(
                out,
                columns=selected_columns,
                herbicides_format=herbicides_format,
                area_units=area_units,
                date_format=date_format,
                weeds_format=weeds_format,
                pcp_lookup=pcp_lookup,
            ))
            if len(rows) >= PREVIEW_LIMIT:
                break
        if len(rows) >= PREVIEW_LIMIT:
            break

    headers = [COLUMN_CATALOG[k] for k in selected_columns]
    return {
        "columns": selected_columns,
        "headers": headers,
        "rows": rows,
        "total_matched": total_matched,
        "truncated": total_matched > len(rows),
        "preview_limit": PREVIEW_LIMIT,
    }


@router.get(
    "/spray-records/export.csv",
    dependencies=[Depends(require_roles(RoleEnum.admin, RoleEnum.office))],
)
def export_spray_records_csv(
    start_date: date_type = Query(...),
    end_date: date_type = Query(...),
    customer: Optional[str] = Query(default=None),
    area: Optional[str] = Query(default=None),
    applicator: Optional[str] = Query(default=None),
    herbicide: Optional[str] = Query(default=None),
    include_avoided: bool = Query(default=False),
    split_roadside: bool = Query(default=False),
    include_totals: bool = Query(default=False),
    columns: Optional[str] = Query(default=None),
    herbicides_format: str = Query(default="pcp", pattern="^(pcp|names|tm_count)$"),
    area_units: str = Query(default="ha", pattern="^(ha|m2|auto|number)$"),
    date_format: str = Query(default="iso", pattern="^(iso|local)$"),
    weeds_format: str = Query(default="all", pattern="^(all|selected_only)$"),
    db: Session = Depends(get_db),
):
    """Generate and return a CSV file containing the spray records."""
    if end_date < start_date:
        raise HTTPException(status_code=400, detail="end_date must be >= start_date")

    selected_columns = _resolve_columns(columns)
    pcp_lookup = _build_pcp_lookup(db)

    site_q, pipeline_q = _build_queries(
        db,
        start_date=start_date,
        end_date=end_date,
        customer=customer,
        area=area,
        applicator=applicator,
        herbicide=herbicide,
        include_avoided=include_avoided,
    )

    # Generate full CSV content in memory to avoid the thread-pool switching overhead
    # of StreamingResponse for small row sizes.
    buffer = io.StringIO()
    writer = csv.writer(buffer, quoting=csv.QUOTE_MINIMAL, lineterminator="\r\n")

    # UTF-8 BOM first so Excel double-click picks the right encoding and
    # renders accents / ° / ² correctly.
    buffer.write("\ufeff")

    # Header row
    writer.writerow([COLUMN_CATALOG[k] for k in selected_columns])

    totals = {"m2_1_herb": 0.0, "m2_2_herb": 0.0, "m2_3_herb": 0.0, "pipeline_roadside_liters": 0.0}

    for record, is_pipeline in _iter_merged_records(site_q, pipeline_q):
        for out in _iter_output_rows(record, is_pipeline, split_roadside):
            row = _build_report_row(
                out,
                columns=selected_columns,
                herbicides_format=herbicides_format,
                area_units=area_units,
                date_format=date_format,
                weeds_format=weeds_format,
                pcp_lookup=pcp_lookup,
            )
            writer.writerow([row[k] for k in selected_columns])

            if include_totals and split_roadside:
                _fold_totals_row(totals, out)

    # Optional year-end totals footer — matches the 4 auto-populated
    # office lines on the T&M ticket.
    if include_totals and split_roadside:
        writer.writerow([])
        writer.writerow(["Totals (T&M office lines)"])
        writer.writerow(["1 Herbicide (m²)", f"{totals['m2_1_herb']:.0f}"])
        writer.writerow(["2 Herbicides (m²)", f"{totals['m2_2_herb']:.0f}"])
        writer.writerow(["3 Herbicides (m²)", f"{totals['m2_3_herb']:.0f}"])
        writer.writerow(["Roadside/Access Rd/Pipeline Liters Applied", f"{totals['pipeline_roadside_liters']:.0f}"])

    csv_content = buffer.getvalue()
    filename = f"pineview-spray-report_{start_date.isoformat()}_{end_date.isoformat()}.csv"

    return Response(
        content=csv_content,
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            # Hint to the browser that this is a one-shot download we don't
            # want stuffed into the HTTP cache.
            "Cache-Control": "no-store",
        },
    )


def _resolve_columns(columns: Optional[str]) -> list[str]:
    """Validate and normalize the `columns` query param.

    Falls back to DEFAULT_COLUMNS when missing or empty. Ignores unknown
    keys silently rather than 400-ing — keeps the UI resilient if someone
    has a stale bookmark after a column rename.
    """
    if not columns:
        return list(DEFAULT_COLUMNS)
    requested = [c.strip() for c in columns.split(",") if c.strip()]
    resolved = [c for c in requested if c in COLUMN_CATALOG]
    return resolved or list(DEFAULT_COLUMNS)


# ── Helper endpoint: distinct values for dashboard filter dropdowns ─────────

@router.get(
    "/spray-records/filter-options",
    dependencies=[Depends(require_roles(RoleEnum.admin, RoleEnum.office))],
)
def filter_options(db: Session = Depends(get_db)):
    """Return distinct { customers, areas } for the dashboard dropdowns.

    Only ever called when the Reports dashboard opens — and only once per
    open — so this is cheap. Herbicide and applicator lists come from the
    existing cached lookups so we don't duplicate them here.
    """
    customers_site = db.execute(text(
        "SELECT DISTINCT client FROM sites WHERE client IS NOT NULL AND deleted_at IS NULL ORDER BY client"
    )).fetchall()
    customers_pipe = db.execute(text(
        "SELECT DISTINCT client FROM pipelines WHERE client IS NOT NULL AND deleted_at IS NULL ORDER BY client"
    )).fetchall()
    areas_site = db.execute(text(
        "SELECT DISTINCT area FROM sites WHERE area IS NOT NULL AND deleted_at IS NULL ORDER BY area"
    )).fetchall()
    areas_pipe = db.execute(text(
        "SELECT DISTINCT area FROM pipelines WHERE area IS NOT NULL AND deleted_at IS NULL ORDER BY area"
    )).fetchall()

    def _uniq_sorted(rows):
        return sorted({r[0] for r in rows if r[0]})

    return {
        "customers": _uniq_sorted(list(customers_site) + list(customers_pipe)),
        "areas": _uniq_sorted(list(areas_site) + list(areas_pipe)),
    }
