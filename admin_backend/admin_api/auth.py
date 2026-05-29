# FILE: ~/otmega/otmega_app/console/admin_backend/admin_api/auth.py
# ماموریت: اعتبارسنجی سبک JWT، تشخیص User Zero و آماده سازی context دسترسی کنسول.

import base64
import hmac
import json
import os
from dataclasses import dataclass

from flask import Request, session


@dataclass(frozen=True)
class ConsoleActor:
    authenticated: bool
    bearer_present: bool
    user_id: str | None
    email: str | None
    full_name: str | None
    title: str | None
    avatar_url: str | None
    avatar_path: str | None
    balance: str
    country_code: str | None
    online_status: str
    last_typed_lang: str
    tier: int
    role: str
    access_level: str
    is_user_zero: bool
    profile_source: str
    advisor_id: int | None


def _decode_unverified_jwt_payload(token: str) -> dict:
    parts = token.split(".")
    if len(parts) < 2:
        return {}
    payload = parts[1] + "=" * (-len(parts[1]) % 4)
    try:
        decoded = base64.urlsafe_b64decode(payload.encode("utf-8"))
        return json.loads(decoded.decode("utf-8"))
    except (ValueError, json.JSONDecodeError):
        return {}


def _to_int(value, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _fallback_actor_profile(email: str) -> dict:
    return {
        "authenticated": True,
        "bearer_present": False,
        "user_id": os.environ.get("CONSOLE_USER_ZERO_ID", "9197bacb-2387-4639-814f-9d643bbfb245"),
        "email": email,
        "full_name": os.environ.get("CONSOLE_ADMIN_FULL_NAME", "System Root"),
        "title": os.environ.get("CONSOLE_ADMIN_TITLE", "User Zero control owner"),
        "avatar_url": os.environ.get("CONSOLE_ADMIN_AVATAR_URL"),
        "avatar_path": os.environ.get("CONSOLE_ADMIN_AVATAR_PATH"),
        "balance": os.environ.get("CONSOLE_ADMIN_BALANCE", "0.00"),
        "country_code": os.environ.get("CONSOLE_ADMIN_COUNTRY_CODE", "us"),
        "online_status": os.environ.get("CONSOLE_ADMIN_ONLINE_STATUS", "online"),
        "last_typed_lang": os.environ.get("CONSOLE_ADMIN_LAST_TYPED_LANG", "en"),
        "tier": _to_int(os.environ.get("CONSOLE_ADMIN_TIER"), 5),
        "role": os.environ.get("CONSOLE_ADMIN_ROLE", "user_zero"),
        "access_level": os.environ.get("CONSOLE_ADMIN_ACCESS_LEVEL", "User Zero"),
        "is_user_zero": True,
        "profile_source": "fallback",
        "advisor_id": _to_int(os.environ.get("CONSOLE_ADVISOR_ID"), 20018),
    }


def fallback_login_enabled() -> bool:
    return bool(os.environ.get("FALLBACK_ADMIN_USER") and os.environ.get("FALLBACK_ADMIN_PASS"))


def authenticate_fallback_admin(email: str, password: str) -> dict | None:
    configured_email = os.environ.get("FALLBACK_ADMIN_USER")
    configured_password = os.environ.get("FALLBACK_ADMIN_PASS")
    if not configured_email or not configured_password:
        return None
    if not hmac.compare_digest(email, configured_email):
        return None
    if not hmac.compare_digest(password, configured_password):
        return None
    return _fallback_actor_profile(email)


def _actor_from_session() -> ConsoleActor | None:
    profile = session.get("console_actor")
    if not isinstance(profile, dict):
        return None
    if not profile.get("authenticated"):
        return None
    return ConsoleActor(
        authenticated=True,
        bearer_present=bool(profile.get("bearer_present")),
        user_id=profile.get("user_id"),
        email=profile.get("email"),
        full_name=profile.get("full_name"),
        title=profile.get("title"),
        avatar_url=profile.get("avatar_url"),
        avatar_path=profile.get("avatar_path"),
        balance=str(profile.get("balance") or "0.00"),
        country_code=profile.get("country_code"),
        online_status=profile.get("online_status") or "offline",
        last_typed_lang=profile.get("last_typed_lang") or "en",
        tier=_to_int(profile.get("tier"), 0),
        role=profile.get("role") or "anonymous",
        access_level=profile.get("access_level") or profile.get("role") or "anonymous",
        is_user_zero=bool(profile.get("is_user_zero")),
        profile_source=profile.get("profile_source") or "session",
        advisor_id=_to_int(profile.get("advisor_id"), 0) or None,
    )


def resolve_actor(request: Request) -> ConsoleActor:
    session_actor = _actor_from_session()
    if session_actor is not None:
        return session_actor

    auth_header = request.headers.get("Authorization", "")
    bearer_present = auth_header.startswith("Bearer ")
    payload = _decode_unverified_jwt_payload(auth_header[7:].strip()) if bearer_present else {}
    user_id = payload.get("sub") or payload.get("user_id")
    email = payload.get("email")
    app_metadata = payload.get("app_metadata") or {}
    user_metadata = payload.get("user_metadata") or {}
    role = app_metadata.get("role") or payload.get("role") or "anonymous"
    is_user_zero = bool(app_metadata.get("is_user_zero") or payload.get("is_user_zero"))

    return ConsoleActor(
        authenticated=bool(user_id),
        bearer_present=bearer_present,
        user_id=user_id,
        email=email,
        full_name=user_metadata.get("full_name") or user_metadata.get("name") or payload.get("full_name"),
        title=user_metadata.get("title") or payload.get("title"),
        avatar_url=user_metadata.get("avatar_url") or payload.get("avatar_url"),
        avatar_path=user_metadata.get("avatar_path") or payload.get("avatar_path"),
        balance=str(user_metadata.get("balance") or payload.get("balance") or "0.00"),
        country_code=user_metadata.get("country_code") or payload.get("country_code"),
        online_status=user_metadata.get("online_status") or payload.get("online_status") or "offline",
        last_typed_lang=user_metadata.get("last_typed_lang") or payload.get("last_typed_lang") or "en",
        tier=_to_int(user_metadata.get("tier") or payload.get("tier"), 0),
        role=role,
        access_level=app_metadata.get("access_level") or payload.get("access_level") or role,
        is_user_zero=is_user_zero,
        profile_source="bearer",
        advisor_id=_to_int(payload.get("advisor_id") or user_metadata.get("advisor_id"), 0) or None,
    )
