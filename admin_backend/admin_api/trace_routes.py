# FILE: ~/otmega/otmega_app/console/admin_backend/admin_api/trace_routes.py
# ماموریت: دریافت، خواندن و stream کردن traceهای Admin Console.

import json
from datetime import datetime, timezone

from flask import Blueprint, Response, jsonify

trace_bp = Blueprint("console_trace", __name__)


@trace_bp.get("/api/console/traces/runs")
def trace_runs():
    return jsonify({"status": "ok", "mode": "read_only", "runs": []})


@trace_bp.get("/api/console/traces/stream")
def trace_stream():
    event = {
        "event": "heartbeat",
        "mode": "read_only",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    payload = f"event: console-heartbeat\ndata: {json.dumps(event)}\n\n"
    return Response(payload, mimetype="text/event-stream")
