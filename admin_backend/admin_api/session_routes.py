# FILE: ~/otmega/otmega_app/console/admin_backend/admin_api/session_routes.py
# ماموریت: API تشخیص session، actor و capabilityهای کاربر لاگین شده.

from flask import Blueprint, jsonify, request, session

from admin_api.auth import authenticate_fallback_admin, fallback_login_enabled, resolve_actor
from admin_api.capabilities import capabilities_for_actor
from admin_api.profile_adapter import load_console_profile

session_bp = Blueprint("console_session", __name__)


def _actor_payload(actor):
    return {
        "authenticated": actor.authenticated,
        "bearer_present": actor.bearer_present,
        "user_id": actor.user_id,
        "email": actor.email,
        "full_name": actor.full_name,
        "title": actor.title,
        "avatar_url": actor.avatar_url,
        "avatar_path": actor.avatar_path,
        "balance": actor.balance,
        "country_code": actor.country_code,
        "online_status": actor.online_status,
        "last_typed_lang": actor.last_typed_lang,
        "tier": actor.tier,
        "role": actor.role,
        "access_level": actor.access_level,
        "is_user_zero": actor.is_user_zero,
        "profile_source": actor.profile_source,
        "advisor_id": actor.advisor_id,
    }


@session_bp.get("/api/console/session")
def session_status():
    actor = resolve_actor(request)
    return jsonify(
        {
            "status": "ok",
            "mode": "read_only",
            "write_enabled": False,
            "login_enabled": fallback_login_enabled(),
            "actor": _actor_payload(actor),
            "capabilities": capabilities_for_actor(actor),
        }
    )


@session_bp.post("/api/console/login")
def login():
    data = request.get_json(silent=True) or {}
    email = str(data.get("email") or "").strip().lower()
    password = str(data.get("password") or "")
    if not email or not password:
        return jsonify({"status": "error", "message": "Email and password are required."}), 400

    profile = authenticate_fallback_admin(email, password)
    if profile is None:
        return jsonify({"status": "error", "message": "Console login failed."}), 401

    real_profile = load_console_profile(email, profile.get("user_id"))
    if real_profile is not None:
        profile = {**profile, **real_profile}

    session.clear()
    session["console_actor"] = profile
    actor = resolve_actor(request)
    return jsonify(
        {
            "status": "ok",
            "mode": "read_only",
            "write_enabled": False,
            "login_enabled": True,
            "actor": _actor_payload(actor),
            "capabilities": capabilities_for_actor(actor),
        }
    )


@session_bp.post("/api/console/logout")
def logout():
    session.clear()
    actor = resolve_actor(request)
    return jsonify(
        {
            "status": "ok",
            "mode": "read_only",
            "write_enabled": False,
            "login_enabled": fallback_login_enabled(),
            "actor": _actor_payload(actor),
            "capabilities": capabilities_for_actor(actor),
        }
    )
