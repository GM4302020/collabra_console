# FILE: ~/otmega/otmega_app/console/admin_backend/admin_api/guards.py
# ماموریت: اعمال capability gate روی routeهای read-only و حساس Admin Console.

from functools import wraps

from flask import jsonify, request

from admin_api.auth import resolve_actor
from admin_api.capabilities import capabilities_for_actor


def require_capability(capability: str):
    def decorator(handler):
        @wraps(handler)
        def wrapper(*args, **kwargs):
            actor = resolve_actor(request)
            if capability not in capabilities_for_actor(actor):
                return jsonify({"status": "error", "message": "Capability denied.", "capability": capability}), 403
            return handler(*args, **kwargs)

        return wrapper

    return decorator
