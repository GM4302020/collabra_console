# FILE: ~/otmega/otmega_app/console/admin_backend/admin_api/config_routes.py
# ماموریت: API مشاهده read-only تنظیمات runtime و configهای فعلی Collabra.

from flask import Blueprint, jsonify
from admin_api.guards import require_capability

config_bp = Blueprint("console_config", __name__)


@config_bp.get("/api/console/config/domains")
@require_capability("console.view_runtime_inventory")
def config_domains():
    return jsonify(
        {
            "status": "ok",
            "mode": "read_only",
            "domains": [
                {"key": "wf1_translation_llm", "source": "config_domain_registry", "write_enabled": False},
                {"key": "zone_visibility_controls", "source": "config_domain_registry", "write_enabled": False},
                {"key": "frontend_version_controls", "source": "config_domain_registry", "write_enabled": False},
                {"key": "guest_banner_controls", "source": "config_domain_registry", "write_enabled": False},
            ],
        }
    )
