# FILE: ~/otmega/otmega_app/console/admin_backend/admin_api/health_routes.py
# ماموریت: routeهای health عمومی و داخلی برای smoke test سرویس کنسول.

from datetime import datetime, timezone

from flask import Blueprint, current_app, jsonify

health_bp = Blueprint("console_health", __name__)


def _health_payload(scope: str) -> dict:
    return {
        "status": "ok",
        "scope": scope,
        "service": current_app.config.get("CONSOLE_SERVICE_NAME", "otmega-console"),
        "mode": current_app.config.get("CONSOLE_MODE", "read_only"),
        "write_enabled": False,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


@health_bp.get("/health")
def public_health():
    return jsonify(_health_payload("public"))


@health_bp.get("/api/console/health")
def console_health():
    return jsonify(_health_payload("console"))
