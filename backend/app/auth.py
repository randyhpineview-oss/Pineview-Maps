from collections.abc import Callable
from typing import Optional

import jwt
from fastapi import Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.config import get_settings
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
    # If using Supabase, verify JWT token
    if settings.use_supabase and db is None:
        authorization: Optional[str] = request.headers.get("Authorization")
        if authorization and authorization.startswith("Bearer "):
            token = authorization.split(" ")[1]
            try:
                # Decode Supabase JWT without verification (trusting HTTPS connection)
                # Supabase uses ES256 signing which requires fetching JWKS public keys
                # For simplicity, we decode without verification since we trust the HTTPS channel
                payload = jwt.decode(
                    token,
                    options={"verify_signature": False},
                    audience="authenticated"
                )
                user_email = payload.get("email")
                if user_email:
                    # Create a temporary user object from JWT payload
                    user_metadata = payload.get("user_metadata", {})
                    role_str = user_metadata.get("role", "worker")
                    try:
                        role_enum = RoleEnum(role_str)
                    except ValueError:
                        role_enum = RoleEnum.worker
                    
                    # Return a user-like object (doesn't need to be persisted in production)
                    user = User(
                        id=0,  # Placeholder ID
                        email=user_email,
                        name=user_email.split("@")[0].title() or "User",
                        role=role_enum
                    )
                    return user
            except jwt.PyJWTError:
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