from collections.abc import Callable
from typing import Optional
import json
import base64

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from app.config import get_settings
from app.database import get_db
from app.models import RoleEnum, User

settings = get_settings()

DEMO_USERS = {
    "admin": {"name": "Pineview Admin", "email": "admin@pineview.local", "role": RoleEnum.admin},
    "office": {"name": "Pineview Office", "email": "office@pineview.local", "role": RoleEnum.office},
    "worker": {"name": "Pineview Worker", "email": "worker@pineview.local", "role": RoleEnum.worker},
}


def seed_demo_users(db: Session) -> None:
    for user_data in DEMO_USERS.values():
        existing = db.query(User).filter(User.email == user_data["email"]).first()
        if existing:
            continue
        db.add(User(**user_data))
    db.commit()


def get_current_user(request: Request, db: Session = Depends(get_db)) -> User:
    # If using Supabase, verify JWT token (check JWT first, regardless of db availability)
    if settings.use_supabase:
        authorization: Optional[str] = request.headers.get("Authorization")
        if authorization and authorization.startswith("Bearer "):
            token = authorization.split(" ")[1]
            try:
                # Decode JWT payload using base64 (no signature verification)
                # JWT format: header.payload.signature
                parts = token.split(".")
                if len(parts) != 3:
                    raise ValueError("Invalid JWT format")
                
                # Decode the payload (second part)
                # Add padding if needed for base64 decode
                payload_b64 = parts[1]
                padding = 4 - (len(payload_b64) % 4)
                if padding != 4:
                    payload_b64 += "=" * padding
                
                payload_bytes = base64.urlsafe_b64decode(payload_b64)
                payload = json.loads(payload_bytes)
                
                user_email = payload.get("email")
                print(f"[AUTH DEBUG] JWT payload email: {user_email}")
                print(f"[AUTH DEBUG] Full JWT payload keys: {list(payload.keys())}")
                if user_email:
                    # Create a temporary user object from JWT payload
                    user_metadata = payload.get("user_metadata", {})
                    role_str = user_metadata.get("role", "worker")
                    try:
                        role_enum = RoleEnum(role_str)
                    except ValueError:
                        role_enum = RoleEnum.worker
                    
                    # Extract actual user ID from Supabase JWT
                    # Supabase uses 'sub' claim for user ID
                    user_id = payload.get("sub")
                    if user_id:
                        try:
                            # Convert string ID to integer if possible
                            actual_id = int(user_id) if user_id.isdigit() else hash(user_id) % 1000000
                        except (ValueError, AttributeError):
                            # Fallback to hash of email
                            actual_id = hash(user_email) % 1000000
                    else:
                        # Fallback to hash of email
                        actual_id = hash(user_email) % 1000000
                    
                    # Return a user-like object (doesn't need to be persisted in production)
                    user = User(
                        id=actual_id,  # Use actual user ID instead of placeholder
                        email=user_email,
                        name=user_email.split("@")[0].title() or "User",
                        role=role_enum
                    )
                    print(f"[AUTH DEBUG] Created user object - ID: {user.id}, Email: {user.email}, Name: {user.name}")
                    return user
            except Exception:
                pass
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or missing token")
    
    # Development mode: use demo users with SQLite
    if db is None:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Database not available")
    
    requested_role = request.headers.get("X-Demo-User", "worker").lower().strip()
    if requested_role not in DEMO_USERS:
        requested_role = "worker"

    user = db.query(User).filter(User.email == DEMO_USERS[requested_role]["email"]).first()
    if user is None:
        seed_demo_users(db)
        user = db.query(User).filter(User.email == DEMO_USERS[requested_role]["email"]).first()
    if user is None:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Demo user setup failed")
    return user


def require_roles(*roles: RoleEnum) -> Callable:
    def dependency(user: User = Depends(get_current_user)) -> User:
        if user.role not in roles:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You do not have access to this action")
        return user

    return dependency