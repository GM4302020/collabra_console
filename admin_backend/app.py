# FILE: ~/otmega/otmega_app/console/admin_backend/app.py
# ماموریت: نقطه ورود Flask برای Admin Console و رجیستر routeهای admin_api.

import os

from flask import Flask

from admin_api.audit_routes import audit_bp
from admin_api.config_routes import config_bp
from admin_api.dashboard_settings_routes import dashboard_settings_bp
from admin_api.gcs_routes import gcs_bp
from admin_api.health_routes import health_bp
from admin_api.operational_routes import operational_bp
from admin_api.session_routes import session_bp
from admin_api.static_routes import register_static_routes
from admin_api.svlip_prefs_routes import svlip_prefs_bp
from admin_api.trace_routes import trace_bp
from admin_api.user_ops_routes import user_ops_bp


def create_app() -> Flask:
    app = Flask(__name__, static_folder=None)
    app.secret_key = os.environ.get("FLASK_SECRET_KEY") or os.environ.get("FALLBACK_ADMIN_PASS") or "otmega-console-read-only"
    app.config["CONSOLE_MODE"] = os.environ.get("CONSOLE_MODE", "read_only")
    app.config["CONSOLE_SERVICE_NAME"] = os.environ.get("K_SERVICE", "otmega-console")
    app.config["SESSION_COOKIE_HTTPONLY"] = True
    app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
    app.config["SESSION_COOKIE_SECURE"] = os.environ.get("CONSOLE_COOKIE_SECURE", "true").lower() != "false"

    app.register_blueprint(health_bp)
    app.register_blueprint(session_bp)
    app.register_blueprint(config_bp)
    app.register_blueprint(dashboard_settings_bp)
    app.register_blueprint(gcs_bp)
    app.register_blueprint(operational_bp)
    app.register_blueprint(trace_bp)
    app.register_blueprint(audit_bp)
    app.register_blueprint(svlip_prefs_bp)
    app.register_blueprint(user_ops_bp)
    register_static_routes(app)
    return app


app = create_app()


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))
