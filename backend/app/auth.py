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
    print(f"[AUTH] get_current_user called: use_supabase={settings.use_supabase}, db={'None' if db is None else 'Session'}")
    
    # If using Supabase, verify JWT token
    if settings.use_supabase and db is None:
        authorization: Optional[str] = request.headers.get("Authorization")
        print(f"[AUTH] Authorization header: {authorization[:50] if authorization else 'None'}...")
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
                if user_email:
                    # Create a temporary user object from JWT payload
                    user_metadata = payload.get("user_metadata", {})
                    role_str = user_metadata.get("role", "worker")
                    print(f"[AUTH] Decoded JWT for {user_email}, role: {role_str}")
                    try:
                        role_enum = RoleEnum(role_str)
                    except ValueError:
                        print(f"[AUTH] Invalid role '{role_str}', defaulting to worker")
                        role_enum = RoleEnum.worker
                    
                    # Return a user-like object (doesn't need to be persisted in production)
                    user = User(
                        id=0,  # Placeholder ID
                        email=user_email,
                        name=user_email.split("@")[0].title() or "User",
                        role=role_enum
                    )
                    print(f"[AUTH] Returning user: {user.email} with role {user.role}")
                    return user
            except Exception as e:
                print(f"[AUTH] JWT decode error: {e}")
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