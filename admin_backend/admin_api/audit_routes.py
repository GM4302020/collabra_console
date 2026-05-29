# FILE: ~/otmega/otmega_app/console/admin_backend/admin_api/audit_routes.py
# ماموریت: API مشاهده audit events و ثبت خواندن های حساس کنسول.

from flask import Blueprint, jsonify
from admin_api.guards import require_capability

audit_bp = Blueprint("console_audit", __name__)


@audit_bp.get("/api/console/audit/events")
@require_capability("console.view_audit")
def audit_events():
    return jsonify({"status": "ok", "mode": "read_only", "events": []})
