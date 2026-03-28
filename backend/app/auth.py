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
    if settings.use_supabase:
        authorization: Optional[str] = request.headers.get("Authorization")
        if authorization and authorization.startswith("Bearer "):
            token = authorization.split(" ")[1]
            try:
                # Verify Supabase JWT
                payload = jwt.decode(
                    token,
                    settings.supabase_anon_key,
                    algorithms=["HS256"],
                    audience="authenticated"
                )
                user_email = payload.get("email")
                if user_email:
                    user = db.query(User).filter(User.email == user_email).first()
                    if user:
                        return user
                    # Create user if doesn't exist (first login)
                    user_metadata = payload.get("user_metadata", {})
                    role_str = user_metadata.get("role", "worker")
                    try:
                        role_enum = RoleEnum(role_str)
                    except ValueError:
                        role_enum = RoleEnum.worker
                    
                    new_user = User(
                        email=user_email,
                        name=payload.get("email", "").split("@")[0].title() or "User",
                        role=role_enum
                    )
                    db.add(new_user)
                    db.commit()
                    db.refresh(new_user)
                    return new_user
            except jwt.PyJWTError:
                pass
        # Fallback to demo users for local development
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