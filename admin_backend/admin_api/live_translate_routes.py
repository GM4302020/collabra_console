# FILE: ~/otmega/otmega_app/console/admin_backend/admin_api/live_translate_routes.py
# ماموریت: APIهای محدود Live Translate برای Routine Tester با token موقت و ذخیره خروجی در GCS.

import base64
import json
import logging
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor, TimeoutError
from datetime import datetime, timedelta, timezone

from flask import Blueprint, jsonify, request

from admin_api.guards import require_capability

live_translate_bp = Blueprint("console_live_translate", __name__)
logger = logging.getLogger(__name__)

MODEL_NAME = "gemini-3.5-live-translate-preview"
MODEL_RESOURCE = f"models/{MODEL_NAME}"
BUCKET_NAME = os.environ.get("APP_DATA_BUCKET_NAME", "otmega-collabra-secure")
SESSION_PREFIX = "advisors/collabra-20018-v1.0.0/main-data/live-translate-sessions"
TOKEN_TIMEOUT_SECONDS = int(os.environ.get("LIVE_TRANSLATE_TOKEN_TIMEOUT_SECONDS", "20"))
TOKEN_EXPIRE_SECONDS = int(os.environ.get("LIVE_TRANSLATE_TOKEN_EXPIRE_SECONDS", "1800"))
TOKEN_NEW_SESSION_EXPIRE_SECONDS = int(os.environ.get("LIVE_TRANSLATE_NEW_SESSION_EXPIRE_SECONDS", "300"))
TOKEN_CONSTRAINT_MODE = "ephemeral_unlocked_setup"

SUPPORTED_LANGUAGES = [
    {"code": "en", "label": "English"},
    {"code": "fa", "label": "فارسی"},
    {"code": "tr", "label": "Türkçe"},
    {"code": "ar", "label": "العربية"},
    {"code": "de", "label": "Deutsch"},
    {"code": "fr", "label": "Français"},
    {"code": "es", "label": "Español"},
    {"code": "it", "label": "Italiano"},
    {"code": "pt", "label": "Português"},
    {"code": "ru", "label": "Русский"},
    {"code": "hi", "label": "हिन्दी"},
    {"code": "ur", "label": "اردو"},
    {"code": "zh", "label": "中文"},
    {"code": "ja", "label": "日本語"},
    {"code": "ko", "label": "한국어"},
]
SUPPORTED_LANGUAGE_CODES = {item["code"] for item in SUPPORTED_LANGUAGES}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _safe_language(value: object, default: str = "en") -> str:
    code = str(value or "").strip().lower()
    return code if code in SUPPORTED_LANGUAGE_CODES else default


def _safe_session_id(value: object) -> str:
    raw = str(value or "").strip()
    if not raw:
        raw = f"lt-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}"
    safe = re.sub(r"[^a-zA-Z0-9_.-]+", "-", raw).strip(".-")
    return safe[:96] or f"lt-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}"


def _api_key() -> str:
    return os.environ.get("GEMINI_API_KEY_25") or os.environ.get("GEMINI_API_KEY") or ""


def _create_ephemeral_token(target_language_code: str, echo_target_language: bool) -> dict:
    api_key = _api_key()
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY_25 is not configured.")

    try:
        from google import genai
    except ImportError as exc:
        raise RuntimeError("google-genai is not installed in console backend.") from exc

    client = genai.Client(api_key=api_key, http_options={"api_version": "v1alpha"})
    now = datetime.now(timezone.utc)
    expire_time = now + timedelta(seconds=TOKEN_EXPIRE_SECONDS)
    new_session_expire_time = now + timedelta(seconds=TOKEN_NEW_SESSION_EXPIRE_SECONDS)
    token = client.auth_tokens.create(
        config={
            "uses": 1,
            "expire_time": expire_time,
            "new_session_expire_time": new_session_expire_time,
            "http_options": {"api_version": "v1alpha"},
        }
    )
    return {
        "access_token": getattr(token, "name", None) or str(token),
        "expires_at": expire_time.isoformat().replace("+00:00", "Z"),
        "new_session_expires_at": new_session_expire_time.isoformat().replace("+00:00", "Z"),
    }


def _create_ephemeral_token_with_timeout(target_language_code: str, echo_target_language: bool) -> tuple[dict, int]:
    start = time.perf_counter()
    executor = ThreadPoolExecutor(max_workers=1)
    try:
        future = executor.submit(_create_ephemeral_token, target_language_code, echo_target_language)
        token_payload = future.result(timeout=TOKEN_TIMEOUT_SECONDS)
        return token_payload, int((time.perf_counter() - start) * 1000)
    except TimeoutError:
        future.cancel()
        raise
    finally:
        executor.shutdown(wait=False, cancel_futures=True)


def _upload_text_blob(bucket, path: str, payload: object) -> None:
    blob = bucket.blob(path)
    blob.upload_from_string(
        json.dumps(payload, ensure_ascii=False, indent=2),
        content_type="application/json; charset=utf-8",
    )


def _upload_b64_blob(bucket, path: str, value: object, content_type: str) -> bool:
    encoded = str(value or "").strip()
    if not encoded:
        return False
    if "," in encoded[:80]:
        encoded = encoded.split(",", 1)[1]
    data = base64.b64decode(encoded)
    blob = bucket.blob(path)
    blob.upload_from_string(data, content_type=content_type)
    return True


def _storage_client():
    from google.cloud import storage

    return storage.Client()


def _read_json_blob(bucket, path: str):
    blob = bucket.blob(path)
    if not blob.exists():
        return None
    return json.loads(blob.download_as_text(encoding="utf-8") or "null")


def _signed_url(bucket, path: str) -> str | None:
    blob = bucket.blob(path)
    if not blob.exists():
        return None
    return blob.generate_signed_url(
        version="v4",
        expiration=timedelta(hours=1),
        method="GET",
    )


@live_translate_bp.get("/api/console/live-translate/config")
@require_capability("console.use_live_translate")
def live_translate_config():
    return jsonify(
        {
            "status": "ok",
            "model": MODEL_NAME,
            "model_resource": MODEL_RESOURCE,
            "default_target_language_code": "en",
            "supported_languages": SUPPORTED_LANGUAGES,
            "input_audio": {"mime_type": "audio/pcm", "sample_rate_hz": 16000, "channels": 1},
            "output_audio": {"mime_type": "audio/pcm", "sample_rate_hz": 24000, "channels": 1},
            "save_prefix": SESSION_PREFIX,
            "auth": {
                "token_strategy": "ephemeral_v1alpha",
                "connect_api_version": "v1alpha",
                "connect_rpc": "BidiGenerateContentConstrained",
                "token_query_param": "access_token",
                "client_send_gate": "setup_complete",
                "setup_shape": "github_live_translate_hybrid",
                "token_constraint_mode": TOKEN_CONSTRAINT_MODE,
                "reference_direct_api_version": "v1beta",
                "api_key_env": "GEMINI_API_KEY_25" if os.environ.get("GEMINI_API_KEY_25") else "GEMINI_API_KEY",
                "api_key_configured": bool(_api_key()),
                "token_timeout_seconds": TOKEN_TIMEOUT_SECONDS,
                "token_expire_seconds": TOKEN_EXPIRE_SECONDS,
                "new_session_expire_seconds": TOKEN_NEW_SESSION_EXPIRE_SECONDS,
            },
        }
    )


@live_translate_bp.get("/api/console/live-translate/sessions")
@require_capability("console.use_live_translate")
def live_translate_sessions():
    try:
        limit = min(50, max(1, int(request.args.get("limit", "10"))))
    except (TypeError, ValueError):
        limit = 10
    try:
        client = _storage_client()
        bucket = client.bucket(BUCKET_NAME)
        session_blobs = bucket.list_blobs(prefix=f"{SESSION_PREFIX}/")
        sessions = []
        for blob in session_blobs:
            if not blob.name.endswith("/session.json"):
                continue
            session_id = blob.name.removeprefix(f"{SESSION_PREFIX}/").removesuffix("/session.json")
            sessions.append(
                {
                    "session_id": session_id,
                    "prefix": f"{SESSION_PREFIX}/{session_id}",
                    "updated": blob.updated.isoformat() if blob.updated else None,
                    "size": blob.size,
                }
            )
        sessions.sort(key=lambda item: item.get("updated") or "", reverse=True)
        return jsonify({"status": "ok", "bucket": BUCKET_NAME, "sessions": sessions[:limit]})
    except Exception as exc:
        return jsonify({"status": "error", "message": f"Live Translate sessions failed: {type(exc).__name__}: {exc}"}), 502


@live_translate_bp.get("/api/console/live-translate/session/<session_id>")
@require_capability("console.use_live_translate")
def live_translate_session_detail(session_id: str):
    safe_session_id = _safe_session_id(session_id)
    prefix = f"{SESSION_PREFIX}/{safe_session_id}"
    try:
        client = _storage_client()
        bucket = client.bucket(BUCKET_NAME)
        return jsonify(
            {
                "status": "ok",
                "bucket": BUCKET_NAME,
                "session_id": safe_session_id,
                "prefix": prefix,
                "session": _read_json_blob(bucket, f"{prefix}/session.json"),
                "input_transcript": _read_json_blob(bucket, f"{prefix}/input_transcript.json"),
                "output_transcript": _read_json_blob(bucket, f"{prefix}/output_transcript.json"),
                "frontend_log": _read_json_blob(bucket, f"{prefix}/frontend_log.json"),
                "backend_log": _read_json_blob(bucket, f"{prefix}/backend_log.json"),
                "source_audio_url": _signed_url(bucket, f"{prefix}/source.wav"),
                "target_audio_url": _signed_url(bucket, f"{prefix}/target.wav"),
            }
        )
    except Exception as exc:
        return jsonify({"status": "error", "message": f"Live Translate session detail failed: {type(exc).__name__}: {exc}"}), 502


@live_translate_bp.post("/api/console/live-translate/session-token")
@require_capability("console.use_live_translate")
def live_translate_session_token():
    payload = request.get_json(silent=True) or {}
    target_language_code = _safe_language(payload.get("target_language_code"), "en")
    echo_target_language = bool(payload.get("echo_target_language"))
    try:
        logger.info("[LiveTranslate] token request target=%s echo=%s", target_language_code, echo_target_language)
        token_payload, latency_ms = _create_ephemeral_token_with_timeout(target_language_code, echo_target_language)
        logger.info("[LiveTranslate] token issued target=%s latency_ms=%s", target_language_code, latency_ms)
    except TimeoutError:
        logger.error("[LiveTranslate] token request timed out after %ss", TOKEN_TIMEOUT_SECONDS)
        return jsonify({"status": "error", "message": f"Live Translate token timed out after {TOKEN_TIMEOUT_SECONDS}s."}), 504
    except Exception as exc:
        logger.error("[LiveTranslate] token failed: %s: %s", type(exc).__name__, exc)
        return jsonify({"status": "error", "message": f"Live Translate token failed: {type(exc).__name__}: {exc}"}), 502
    return jsonify(
        {
            "status": "ok",
            "access_token": token_payload["access_token"],
            "model": MODEL_NAME,
            "model_resource": MODEL_RESOURCE,
            "target_language_code": target_language_code,
            "echo_target_language": echo_target_language,
            "expires_in_seconds": TOKEN_EXPIRE_SECONDS,
            "new_session_expires_in_seconds": TOKEN_NEW_SESSION_EXPIRE_SECONDS,
            "expires_at": token_payload["expires_at"],
            "new_session_expires_at": token_payload["new_session_expires_at"],
            "latency_ms": latency_ms,
            "auth_mode": "ephemeral_v1alpha",
            "token_constraint_mode": TOKEN_CONSTRAINT_MODE,
            "setup_shape": "github_live_translate_hybrid",
            "client_send_gate": "setup_complete",
        }
    )


@live_translate_bp.post("/api/console/live-translate/save-session")
@require_capability("console.use_live_translate")
def live_translate_save_session():
    payload = request.get_json(silent=True) or {}
    session_id = _safe_session_id(payload.get("session_id"))
    target_language_code = _safe_language(payload.get("target_language_code"), "en")
    prefix = f"{SESSION_PREFIX}/{session_id}"
    saved_paths = []

    session_payload = {
        "session_id": session_id,
        "model": MODEL_NAME,
        "target_language_code": target_language_code,
        "source_language_code": str(payload.get("source_language_code") or "auto").strip() or "auto",
        "echo_target_language": bool(payload.get("echo_target_language")),
        "input_segment_count": len(payload.get("input_transcript") or []),
        "output_segment_count": len(payload.get("output_transcript") or []),
        "metadata": payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {},
        "saved_at": _now_iso(),
    }
    metadata = session_payload["metadata"] if isinstance(session_payload["metadata"], dict) else {}
    frontend_log = metadata.get("frontend_log") if isinstance(metadata.get("frontend_log"), list) else []
    backend_log = {
        "saved_at": session_payload["saved_at"],
        "session_id": session_id,
        "bucket": BUCKET_NAME,
        "prefix": prefix,
        "target_language_code": target_language_code,
        "source_language_code": session_payload["source_language_code"],
        "input_segment_count": session_payload["input_segment_count"],
        "output_segment_count": session_payload["output_segment_count"],
        "has_source_audio": bool(payload.get("source_audio_wav_base64")),
        "has_target_audio": bool(payload.get("target_audio_wav_base64")),
        "source_audio_b64_chars": len(str(payload.get("source_audio_wav_base64") or "")),
        "target_audio_b64_chars": len(str(payload.get("target_audio_wav_base64") or "")),
        "monitor": metadata.get("monitor") if isinstance(metadata.get("monitor"), dict) else None,
        "request_remote_addr": request.headers.get("X-Forwarded-For") or request.remote_addr,
        "user_agent": request.headers.get("User-Agent"),
    }

    try:
        client = _storage_client()
        bucket = client.bucket(BUCKET_NAME)
        writes = [
            (f"{prefix}/session.json", session_payload),
            (f"{prefix}/input_transcript.json", payload.get("input_transcript") or []),
            (f"{prefix}/output_transcript.json", payload.get("output_transcript") or []),
            (f"{prefix}/frontend_log.json", frontend_log),
            (f"{prefix}/backend_log.json", backend_log),
        ]
        for path, body in writes:
            _upload_text_blob(bucket, path, body)
            saved_paths.append(path)
        if _upload_b64_blob(bucket, f"{prefix}/source.wav", payload.get("source_audio_wav_base64"), "audio/wav"):
            saved_paths.append(f"{prefix}/source.wav")
        if _upload_b64_blob(bucket, f"{prefix}/target.wav", payload.get("target_audio_wav_base64"), "audio/wav"):
            saved_paths.append(f"{prefix}/target.wav")
    except ImportError:
        return jsonify({"status": "error", "message": "google-cloud-storage is not installed."}), 500
    except Exception as exc:
        return jsonify({"status": "error", "message": f"Live Translate save failed: {type(exc).__name__}: {exc}"}), 502

    return jsonify(
        {
            "status": "ok",
            "bucket": BUCKET_NAME,
            "session_id": session_id,
            "prefix": prefix,
            "saved_paths": saved_paths,
        }
    )
