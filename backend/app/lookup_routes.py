"""Lookup tables API endpoints for herbicides, applicators, noxious weeds, and location types."""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import text
from sqlalchemy.orm import Session
from typing import List

from app.auth import require_roles, get_current_user
from app.database import get_db
from app.models import RoleEnum, User

router = APIRouter(prefix="/api/lookups", tags=["lookups"])


# ========== Herbicides ==========

@router.get("/herbicides")
def list_herbicides(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List all active herbicides."""
    result = db.execute(text(
        "SELECT id, name, pcp_number, is_active FROM herbicides WHERE is_active = TRUE ORDER BY name"
    ))
    return [{"id": row[0], "name": row[1], "pcp_number": row[2], "is_active": row[3]} for row in result]


@router.post("/herbicides", dependencies=[Depends(require_roles(RoleEnum.admin))])
def create_herbicide(
    payload: dict,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Create a new herbicide (admin only)."""
    result = db.execute(text(
        "INSERT INTO herbicides (name, pcp_number) VALUES (:name, :pcp_number) RETURNING id"
    ), {"name": payload["name"], "pcp_number": payload.get("pcp_number")})
    db.commit()
    new_id = result.scalar()
    return {"id": new_id, "name": payload["name"], "pcp_number": payload.get("pcp_number")}


@router.patch("/herbicides/{herbicide_id}", dependencies=[Depends(require_roles(RoleEnum.admin))])
def update_herbicide(
    herbicide_id: int,
    payload: dict,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update a herbicide (admin only)."""
    db.execute(text(
        "UPDATE herbicides SET name = :name, pcp_number = :pcp_number, is_active = :is_active WHERE id = :id"
    ), {
        "id": herbicide_id,
        "name": payload.get("name"),
        "pcp_number": payload.get("pcp_number"),
        "is_active": payload.get("is_active", True)
    })
    db.commit()
    return {"id": herbicide_id, **payload}


@router.delete("/herbicides/{herbicide_id}", dependencies=[Depends(require_roles(RoleEnum.admin))])
def delete_herbicide(
    herbicide_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Soft delete a herbicide by setting is_active = False (admin only)."""
    db.execute(text(
        "UPDATE herbicides SET is_active = FALSE WHERE id = :id"
    ), {"id": herbicide_id})
    db.commit()
    return {"success": True}


# ========== Applicators ==========

@router.get("/applicators")
def list_applicators(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List all active applicators."""
    result = db.execute(text(
        "SELECT id, name, license_number, is_active FROM applicators WHERE is_active = TRUE ORDER BY name"
    ))
    return [{"id": row[0], "name": row[1], "license_number": row[2], "is_active": row[3]} for row in result]


@router.post("/applicators", dependencies=[Depends(require_roles(RoleEnum.admin))])
def create_applicator(
    payload: dict,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Create a new applicator (admin only)."""
    result = db.execute(text(
        "INSERT INTO applicators (name, license_number) VALUES (:name, :license_number) RETURNING id"
    ), {"name": payload["name"], "license_number": payload.get("license_number")})
    db.commit()
    new_id = result.scalar()
    return {"id": new_id, "name": payload["name"], "license_number": payload.get("license_number")}


@router.patch("/applicators/{applicator_id}", dependencies=[Depends(require_roles(RoleEnum.admin))])
def update_applicator(
    applicator_id: int,
    payload: dict,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update an applicator (admin only)."""
    db.execute(text(
        "UPDATE applicators SET name = :name, license_number = :license_number, is_active = :is_active WHERE id = :id"
    ), {
        "id": applicator_id,
        "name": payload.get("name"),
        "license_number": payload.get("license_number"),
        "is_active": payload.get("is_active", True)
    })
    db.commit()
    return {"id": applicator_id, **payload}


@router.delete("/applicators/{applicator_id}", dependencies=[Depends(require_roles(RoleEnum.admin))])
def delete_applicator(
    applicator_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Soft delete an applicator by setting is_active = False (admin only)."""
    db.execute(text(
        "UPDATE applicators SET is_active = FALSE WHERE id = :id"
    ), {"id": applicator_id})
    db.commit()
    return {"success": True}


# ========== Noxious Weeds ==========

@router.get("/noxious-weeds")
def list_noxious_weeds(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List all active noxious weeds."""
    result = db.execute(text(
        "SELECT id, name, is_active FROM noxious_weeds WHERE is_active = TRUE ORDER BY name"
    ))
    return [{"id": row[0], "name": row[1], "is_active": row[2]} for row in result]


@router.post("/noxious-weeds", dependencies=[Depends(require_roles(RoleEnum.admin))])
def create_noxious_weed(
    payload: dict,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Create a new noxious weed entry (admin only)."""
    result = db.execute(text(
        "INSERT INTO noxious_weeds (name) VALUES (:name) RETURNING id"
    ), {"name": payload["name"]})
    db.commit()
    new_id = result.scalar()
    return {"id": new_id, "name": payload["name"]}


@router.patch("/noxious-weeds/{weed_id}", dependencies=[Depends(require_roles(RoleEnum.admin))])
def update_noxious_weed(
    weed_id: int,
    payload: dict,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update a noxious weed entry (admin only)."""
    db.execute(text(
        "UPDATE noxious_weeds SET name = :name, is_active = :is_active WHERE id = :id"
    ), {
        "id": weed_id,
        "name": payload.get("name"),
        "is_active": payload.get("is_active", True)
    })
    db.commit()
    return {"id": weed_id, **payload}


@router.delete("/noxious-weeds/{weed_id}", dependencies=[Depends(require_roles(RoleEnum.admin))])
def delete_noxious_weed(
    weed_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Soft delete a noxious weed by setting is_active = False (admin only)."""
    db.execute(text(
        "UPDATE noxious_weeds SET is_active = FALSE WHERE id = :id"
    ), {"id": weed_id})
    db.commit()
    return {"success": True}


# ========== Location Types ==========

@router.get("/location-types")
def list_location_types(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List all active location types."""
    result = db.execute(text(
        "SELECT id, name, is_active, is_access_road, is_pipeline FROM location_types WHERE is_active = TRUE ORDER BY name"
    ))
    return [
        {
            "id": row[0],
            "name": row[1],
            "is_active": row[2],
            "is_access_road": row[3],
            "is_pipeline": row[4],
        }
        for row in result
    ]


@router.post("/location-types", dependencies=[Depends(require_roles(RoleEnum.admin))])
def create_location_type(
    payload: dict,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Create a new location type (admin only)."""
    result = db.execute(text(
        "INSERT INTO location_types (name, is_access_road, is_pipeline) "
        "VALUES (:name, :is_access_road, :is_pipeline) RETURNING id"
    ), {
        "name": payload["name"],
        "is_access_road": payload.get("is_access_road", False),
        "is_pipeline": payload.get("is_pipeline", False),
    })
    db.commit()
    new_id = result.scalar()
    return {
        "id": new_id,
        "name": payload["name"],
        "is_access_road": payload.get("is_access_road", False),
        "is_pipeline": payload.get("is_pipeline", False),
    }


@router.patch("/location-types/{type_id}", dependencies=[Depends(require_roles(RoleEnum.admin))])
def update_location_type(
    type_id: int,
    payload: dict,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update a location type (admin only)."""
    db.execute(text(
        "UPDATE location_types SET name = :name, is_access_road = :is_access_road, "
        "is_pipeline = :is_pipeline, is_active = :is_active WHERE id = :id"
    ), {
        "id": type_id,
        "name": payload.get("name"),
        "is_access_road": payload.get("is_access_road", False),
        "is_pipeline": payload.get("is_pipeline", False),
        "is_active": payload.get("is_active", True),
    })
    db.commit()
    return {"id": type_id, **payload}


@router.delete("/location-types/{type_id}", dependencies=[Depends(require_roles(RoleEnum.admin))])
def delete_location_type(
    type_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Soft delete a location type by setting is_active = False (admin only)."""
    db.execute(text(
        "UPDATE location_types SET is_active = FALSE WHERE id = :id"
    ), {"id": type_id})
    db.commit()
    return {"success": True}
