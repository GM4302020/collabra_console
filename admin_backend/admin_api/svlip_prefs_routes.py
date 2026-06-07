# FILE: ~/otmega/otmega_app/console/admin_backend/admin_api/svlip_prefs_routes.py
# ماموریت: ذخیره و بازیابی ترجیحات مدل SVLIP (زبان → مدل) در GCS برای ماندگاری cross-device.

import json
import logging
import os

import requests as _rq
from flask import Blueprint, jsonify, request
from google.cloud import storage

from admin_api.guards import require_capability

svlip_prefs_bp = Blueprint("svlip_prefs", __name__)
logger = logging.getLogger(__name__)

BUCKET_NAME = os.environ.get("APP_DATA_BUCKET_NAME", "otmega-collabra-secure")
PREFS_BLOB = "advisors/collabra-20018-v1.0.0/main-data/svlip_model_language_prefs.json"
LIVE_ASR_CONFIG_BLOB = "advisors/collabra-20018-v1.0.0/main-data/live_asr_config.json"
MAIN_BACKEND_URL = os.environ.get("MAIN_BACKEND_URL", "https://api.otmega.com")

_LIVE_ASR_CONFIG_DEFAULT: dict = {
    "active_model": "whisper-large-v3",
    "available_models": ["whisper-large-v3", "whisper-large-v3-turbo"],
}

_storage_client: storage.Client | None = None


def _get_storage() -> storage.Client:
    global _storage_client
    if _storage_client is None:
        _storage_client = storage.Client()
    return _storage_client


def _read_prefs() -> dict:
    try:
        blob = _get_storage().bucket(BUCKET_NAME).blob(PREFS_BLOB)
        if not blob.exists():
            return {}
        return json.loads(blob.download_as_text(encoding="utf-8"))
    except Exception as e:
        logger.error("svlip_prefs: read failed: %s", e)
        return {}


def _write_prefs(prefs: dict) -> None:
    blob = _get_storage().bucket(BUCKET_NAME).blob(PREFS_BLOB)
    blob.upload_from_string(
        json.dumps(prefs, ensure_ascii=False, indent=2),
        content_type="application/json",
    )


@svlip_prefs_bp.get("/api/console/svlip/model-prefs")
@require_capability("console.use_transcript_api")
def get_model_prefs():
    return jsonify({"status": "ok", "prefs": _read_prefs()})


@svlip_prefs_bp.post("/api/console/svlip/model-prefs")
@require_capability("console.use_transcript_api")
def set_model_pref():
    payload = request.get_json(silent=True) or {}
    lang = str(payload.get("language") or "").strip().lower()[:10]
    model_key = str(payload.get("model_key") or "").strip()
    clear = bool(payload.get("clear"))

    if not lang:
        return jsonify({"status": "error", "message": "language required"}), 400

    prefs = _read_prefs()
    if clear or not model_key:
        prefs.pop(lang, None)
    else:
        prefs[lang] = model_key

    _write_prefs(prefs)
    return jsonify({"status": "ok", "prefs": prefs})


@svlip_prefs_bp.post("/api/console/svlip/live-chunk")
@require_capability("console.use_transcript_api")
def live_chunk():
    """Proxy live audio chunk to main backend Groq Whisper endpoint."""
    if 'audio' not in request.files:
        return jsonify({"status": "error", "message": "audio field required"}), 400

    audio_file = request.files['audio']
    whisper_model = (request.form.get('whisper_model') or 'whisper-large-v3').strip()

    try:
        resp = _rq.post(
            f"{MAIN_BACKEND_URL}/api/audio/live-transcribe",
            files={"audio": (
                audio_file.filename or "chunk.webm",
                audio_file.stream,
                audio_file.content_type or "audio/webm",
            )},
            data={"whisper_model": whisper_model},
            timeout=30,
        )
        try:
            data = resp.json()
        except ValueError:
            logger.error("live_chunk: main backend non-JSON (status=%d): %r", resp.status_code, resp.text[:300])
            return jsonify({"status": "error", "message": f"main backend returned non-JSON (HTTP {resp.status_code})"}), 500
        return jsonify(data), resp.status_code
    except Exception as e:
        logger.error("live_chunk proxy error: %s", e)
        return jsonify({"status": "error", "message": str(e)}), 500


@svlip_prefs_bp.get("/api/console/svlip/live-asr-config")
@require_capability("console.use_transcript_api")
def get_live_asr_config():
    """بازیابی تنظیمات LASR-PTT از GCS — با fallback به مقادیر پیش‌فرض."""
    try:
        blob = _get_storage().bucket(BUCKET_NAME).blob(LIVE_ASR_CONFIG_BLOB)
        if blob.exists():
            config = json.loads(blob.download_as_text(encoding="utf-8"))
            if config.get("active_model") not in ('whisper-large-v3', 'whisper-large-v3-turbo'):
                config["active_model"] = "whisper-large-v3"
        else:
            config = _LIVE_ASR_CONFIG_DEFAULT.copy()
        return jsonify({"status": "ok", "config": config})
    except Exception as e:
        logger.error("live_asr_config: read failed: %s", e)
        return jsonify({"status": "ok", "config": _LIVE_ASR_CONFIG_DEFAULT.copy()})


@svlip_prefs_bp.post("/api/console/svlip/live-asr-config")
@require_capability("console.use_transcript_api")
def set_live_asr_config():
    """ذخیره تنظیمات LASR-PTT در GCS."""
    payload = request.get_json(silent=True) or {}
    active_model = str(payload.get("active_model") or "").strip()
    if active_model not in ('whisper-large-v3', 'whisper-large-v3-turbo'):
        return jsonify({"status": "error", "message": "active_model must be whisper-large-v3 or whisper-large-v3-turbo"}), 400
    try:
        config = {
            "active_model": active_model,
            "available_models": ["whisper-large-v3", "whisper-large-v3-turbo"],
        }
        blob = _get_storage().bucket(BUCKET_NAME).blob(LIVE_ASR_CONFIG_BLOB)
        blob.upload_from_string(
            json.dumps(config, ensure_ascii=False, indent=2),
            content_type="application/json",
        )
        return jsonify({"status": "ok", "config": config})
    except Exception as e:
        logger.error("live_asr_config: write failed: %s", e)
        return jsonify({"status": "error", "message": str(e)}), 500
