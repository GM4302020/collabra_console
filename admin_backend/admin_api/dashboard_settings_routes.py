# FILE: ~/otmega/otmega_app/console/admin_backend/admin_api/dashboard_settings_routes.py
# ماموریت: ذخیره و بازیابی تنظیمات چیدمان Admin Console در GCS.

import datetime as _dt
import json
import logging
import os
import re

from flask import Blueprint, jsonify, request
from google.cloud import storage

from admin_api.auth import resolve_actor
from admin_api.guards import require_capability

dashboard_settings_bp = Blueprint("console_dashboard_settings", __name__)
logger = logging.getLogger(__name__)

BUCKET_NAME = os.environ.get("APP_DATA_BUCKET_NAME", "otmega-collabra-secure")
SETTINGS_BLOB = "advisors/collabra-20018-v1.0.0/main-data/admin-console-dashboard-settings.json"
SCHEMA_VERSION = 1
MAX_SECTION_BYTES = 24_000

_storage_client: storage.Client | None = None


def _utc_now() -> str:
    return _dt.datetime.now(_dt.UTC).isoformat().replace("+00:00", "Z")


def _get_storage() -> storage.Client:
    global _storage_client
    if _storage_client is None:
        _storage_client = storage.Client()
    return _storage_client


def _actor_key(actor) -> str:
    raw = (actor.email or actor.user_id or "anonymous").strip().lower()
    return re.sub(r"[^a-z0-9_.@-]+", "_", raw)[:160] or "anonymous"


def _empty_document() -> dict:
    return {
        "schema_version": SCHEMA_VERSION,
        "description": "Admin Console dashboard/page layout preferences. No application data or secrets.",
        "updated_at": None,
        "updated_by": None,
        "actors": {},
    }


def _read_document() -> dict:
    blob = _get_storage().bucket(BUCKET_NAME).blob(SETTINGS_BLOB)
    if not blob.exists():
        return _empty_document()
    try:
        data = json.loads(blob.download_as_text(encoding="utf-8"))
    except Exception as exc:
        logger.error("dashboard_settings: read failed: %s", exc)
        return _empty_document()
    if not isinstance(data, dict):
        return _empty_document()
    data.setdefault("schema_version", SCHEMA_VERSION)
    data.setdefault("actors", {})
    if not isinstance(data["actors"], dict):
        data["actors"] = {}
    return data


def _write_document(document: dict) -> None:
    blob = _get_storage().bucket(BUCKET_NAME).blob(SETTINGS_BLOB)
    blob.upload_from_string(
        json.dumps(document, ensure_ascii=False, indent=2, sort_keys=True),
        content_type="application/json",
    )


def _current_actor_entry(document: dict, actor) -> tuple[str, dict]:
    key = _actor_key(actor)
    actors = document.setdefault("actors", {})
    entry = actors.get(key)
    if not isinstance(entry, dict):
        entry = {}
        actors[key] = entry
    entry.setdefault("actor_email", actor.email)
    entry.setdefault("actor_user_id", actor.user_id)
    entry.setdefault("settings", {})
    if not isinstance(entry["settings"], dict):
        entry["settings"] = {}
    return key, entry


@dashboard_settings_bp.get("/api/console/dashboard-settings")
@require_capability("console.manage_dashboard_settings")
def get_dashboard_settings():
    actor = resolve_actor(request)
    document = _read_document()
    actor_key, entry = _current_actor_entry(document, actor)
    return jsonify({
        "status": "ok",
        "bucket": BUCKET_NAME,
        "path": SETTINGS_BLOB,
        "actor_key": actor_key,
        "settings": entry.get("settings") or {},
        "updated_at": entry.get("updated_at"),
    })


@dashboard_settings_bp.post("/api/console/dashboard-settings")
@require_capability("console.manage_dashboard_settings")
def save_dashboard_settings():
    actor = resolve_actor(request)
    payload = request.get_json(silent=True) or {}
    section = str(payload.get("section") or "").strip()
    value = payload.get("value")

    if not re.match(r"^[a-z][a-z0-9_]{1,63}$", section):
        return jsonify({"status": "error", "message": "section must be a stable snake_case key."}), 400
    if not isinstance(value, dict):
        return jsonify({"status": "error", "message": "value must be an object."}), 400
    if len(json.dumps(value, ensure_ascii=False)) > MAX_SECTION_BYTES:
        return jsonify({"status": "error", "message": "settings section is too large."}), 413

    document = _read_document()
    actor_key, entry = _current_actor_entry(document, actor)
    now = _utc_now()
    entry["actor_email"] = actor.email
    entry["actor_user_id"] = actor.user_id
    entry["settings"][section] = value
    entry["updated_at"] = now
    document["schema_version"] = SCHEMA_VERSION
    document["updated_at"] = now
    document["updated_by"] = actor.email or actor.user_id
    _write_document(document)

    return jsonify({
        "status": "ok",
        "bucket": BUCKET_NAME,
        "path": SETTINGS_BLOB,
        "actor_key": actor_key,
        "settings": entry["settings"],
        "updated_at": entry["updated_at"],
    })
