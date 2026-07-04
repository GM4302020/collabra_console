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
INLINE_AUDIO_MAX_BYTES = int(os.environ.get("LIVE_TRANSLATE_INLINE_AUDIO_MAX_BYTES", "8000000"))
CLONE_HTTP_TIMEOUT_SECONDS = int(os.environ.get("LIVE_TRANSLATE_CLONE_HTTP_TIMEOUT_SECONDS", "90"))
CLONE_MAX_AUDIO_BYTES = int(os.environ.get("LIVE_TRANSLATE_CLONE_MAX_AUDIO_BYTES", "12000000"))
CLONE_MAX_TEXT_CHARS = int(os.environ.get("LIVE_TRANSLATE_CLONE_MAX_TEXT_CHARS", "6000"))
ELEVENLABS_API_BASE = os.environ.get("ELEVENLABS_API_BASE", "https://api.elevenlabs.io/v1").rstrip("/")
ELEVENLABS_STS_MODEL_ID = os.environ.get("ELEVENLABS_STS_MODEL_ID", "eleven_multilingual_sts_v2")
ELEVENLABS_TTS_MODEL_ID = os.environ.get("ELEVENLABS_TTS_MODEL_ID", "eleven_multilingual_v2")
ELEVENLABS_OUTPUT_FORMAT = os.environ.get("ELEVENLABS_OUTPUT_FORMAT", "mp3_44100_128")
ELEVENLABS_IVC_MIN_SOURCE_SECONDS = float(os.environ.get("ELEVENLABS_IVC_MIN_SOURCE_SECONDS", "30"))
GOOGLE_TTS_API_BASE = os.environ.get("GOOGLE_TTS_API_BASE", "https://texttospeech.googleapis.com").rstrip("/")
GOOGLE_TTS_PROJECT_ID = (
    os.environ.get("GOOGLE_TTS_PROJECT_ID")
    or os.environ.get("GOOGLE_CLOUD_PROJECT")
    or os.environ.get("GCLOUD_PROJECT")
    or os.environ.get("GCP_PROJECT")
    or ""
)
GOOGLE_TTS_VOICE_CLONING_KEY = os.environ.get("GOOGLE_TTS_VOICE_CLONING_KEY", "")
GOOGLE_TTS_DEFAULT_LANGUAGE_CODE = os.environ.get("GOOGLE_TTS_DEFAULT_LANGUAGE_CODE", "en-US")
GOOGLE_TTS_OUTPUT_ENCODING = os.environ.get("GOOGLE_TTS_OUTPUT_ENCODING", "LINEAR16")

SUPPORTED_LANGUAGES = [
    {"code": "af", "label": "Afrikaans"},
    {"code": "ak", "label": "Akan"},
    {"code": "sq", "label": "Albanian"},
    {"code": "am", "label": "Amharic"},
    {"code": "ar", "label": "العربية"},
    {"code": "hy", "label": "Armenian"},
    {"code": "az", "label": "Azerbaijani"},
    {"code": "eu", "label": "Basque"},
    {"code": "be", "label": "Belarusian"},
    {"code": "bn", "label": "Bengali"},
    {"code": "bg", "label": "Bulgarian"},
    {"code": "my", "label": "Burmese (Myanmar)"},
    {"code": "ca", "label": "Catalan"},
    {"code": "zh-Hans", "label": "Chinese (Simplified)"},
    {"code": "zh-Hant", "label": "Chinese (Traditional)"},
    {"code": "hr", "label": "Croatian"},
    {"code": "cs", "label": "Czech"},
    {"code": "da", "label": "Danish"},
    {"code": "nl", "label": "Dutch"},
    {"code": "en", "label": "English"},
    {"code": "et", "label": "Estonian"},
    {"code": "fil", "label": "Filipino"},
    {"code": "fi", "label": "Finnish"},
    {"code": "fr", "label": "Français"},
    {"code": "gl", "label": "Galician"},
    {"code": "ka", "label": "Georgian"},
    {"code": "de", "label": "Deutsch"},
    {"code": "el", "label": "Greek"},
    {"code": "gu", "label": "Gujarati"},
    {"code": "ha", "label": "Hausa"},
    {"code": "he", "label": "Hebrew"},
    {"code": "hi", "label": "हिन्दी"},
    {"code": "hu", "label": "Hungarian"},
    {"code": "is", "label": "Icelandic"},
    {"code": "id", "label": "Indonesian"},
    {"code": "it", "label": "Italiano"},
    {"code": "ja", "label": "日本語"},
    {"code": "jv", "label": "Javanese"},
    {"code": "kn", "label": "Kannada"},
    {"code": "kk", "label": "Kazakh"},
    {"code": "km", "label": "Khmer"},
    {"code": "rw", "label": "Kinyarwanda"},
    {"code": "ko", "label": "한국어"},
    {"code": "lo", "label": "Lao"},
    {"code": "lv", "label": "Latvian"},
    {"code": "lt", "label": "Lithuanian"},
    {"code": "mk", "label": "Macedonian"},
    {"code": "ms", "label": "Malay"},
    {"code": "ml", "label": "Malayalam"},
    {"code": "mr", "label": "Marathi"},
    {"code": "mn", "label": "Mongolian"},
    {"code": "ne", "label": "Nepali"},
    {"code": "no", "label": "Norwegian"},
    {"code": "nb", "label": "Norwegian Bokmal"},
    {"code": "fa", "label": "فارسی"},
    {"code": "pl", "label": "Polski"},
    {"code": "pt-BR", "label": "Portuguese (Brazil)"},
    {"code": "pt-PT", "label": "Portuguese (Portugal)"},
    {"code": "pa", "label": "Punjabi"},
    {"code": "ro", "label": "Romanian"},
    {"code": "ru", "label": "Русский"},
    {"code": "sr", "label": "Serbian"},
    {"code": "sd", "label": "Sindhi"},
    {"code": "si", "label": "Sinhala"},
    {"code": "sk", "label": "Slovak"},
    {"code": "sl", "label": "Slovenian"},
    {"code": "es", "label": "Español"},
    {"code": "su", "label": "Sundanese"},
    {"code": "sw", "label": "Swahili"},
    {"code": "sv", "label": "Swedish"},
    {"code": "ta", "label": "Tamil"},
    {"code": "te", "label": "Telugu"},
    {"code": "th", "label": "Thai"},
    {"code": "tr", "label": "Türkçe"},
    {"code": "uk", "label": "Ukrainian"},
    {"code": "ur", "label": "اردو"},
    {"code": "uz", "label": "Uzbek"},
    {"code": "vi", "label": "Vietnamese"},
    {"code": "zu", "label": "Zulu"},
]
SUPPORTED_LANGUAGE_CODES = {item["code"].lower(): item["code"] for item in SUPPORTED_LANGUAGES}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _safe_language(value: object, default: str = "en") -> str:
    code = str(value or "").strip().lower()
    return SUPPORTED_LANGUAGE_CODES.get(code, default)


def _safe_session_id(value: object) -> str:
    raw = str(value or "").strip()
    if not raw:
        raw = f"lt-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}"
    safe = re.sub(r"[^a-zA-Z0-9_.-]+", "-", raw).strip(".-")
    return safe[:96] or f"lt-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}"


def _safe_speaker_email(value: object) -> str:
    email = str(value or "").strip().lower()
    if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email):
        return ""
    return email[:160]


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


def _upload_binary_blob(bucket, path: str, data: bytes, content_type: str) -> None:
    blob = bucket.blob(path)
    blob.upload_from_string(data, content_type=content_type)


def _storage_client():
    from google.cloud import storage

    return storage.Client()


def _read_json_blob(bucket, path: str):
    blob = bucket.blob(path)
    if not blob.exists():
        return None
    return json.loads(blob.download_as_text(encoding="utf-8") or "null")


def _download_blob_bytes(bucket, path: str) -> bytes | None:
    blob = bucket.blob(path)
    if not blob.exists():
        return None
    if blob.size is None:
        blob.reload()
    return blob.download_as_bytes()


def _signed_url(bucket, path: str) -> str | None:
    blob = bucket.blob(path)
    if not blob.exists():
        return None
    signed_url = blob.generate_signed_url(
        version="v4",
        expiration=timedelta(hours=1),
        method="GET",
    )
    return signed_url.replace("storage.googleapis.com", "files.otmega.com")


def _audio_blob_payload(bucket, path: str) -> dict:
    blob = bucket.blob(path)
    if not blob.exists():
        return {"url": None, "base64": None, "mime_type": None}
    signed_url = _signed_url(bucket, path)
    if blob.size is None:
        blob.reload()
    if blob.size is not None and blob.size > INLINE_AUDIO_MAX_BYTES:
        return {"url": signed_url, "base64": None, "mime_type": blob.content_type or "audio/wav"}
    data = blob.download_as_bytes()
    return {
        "url": signed_url,
        "base64": base64.b64encode(data).decode("ascii"),
        "mime_type": blob.content_type or "audio/wav",
    }


def _first_audio_blob_payload(bucket, paths: list[str]) -> dict:
    for path in paths:
        payload = _audio_blob_payload(bucket, path)
        if payload["url"] or payload["base64"]:
            return payload
    return {"url": None, "base64": None, "mime_type": None}


def _clone_output_extension(provider_key: str) -> str:
    return "mp3" if provider_key == "elevenlabs" else "wav"


def _safe_voice_reference(value: object) -> str:
    return str(value or "").strip()[:256]


def _provider_error_detail(response) -> dict:
    text = str(getattr(response, "text", "") or "")
    payload = None
    try:
        payload = response.json()
    except Exception:
        try:
            payload = json.loads(text)
        except Exception:
            payload = None
    detail = payload.get("detail") if isinstance(payload, dict) else None
    if isinstance(detail, dict):
        return {
            "type": str(detail.get("type") or ""),
            "code": str(detail.get("code") or ""),
            "status": str(detail.get("status") or ""),
            "message": str(detail.get("message") or ""),
        }
    return {"type": "", "code": "", "status": "", "message": ""}


def _output_transcript_text(bucket, path: str) -> str:
    transcript = _read_json_blob(bucket, path)
    if not isinstance(transcript, list):
        return ""
    parts = []
    for item in transcript:
        if isinstance(item, dict):
            text = str(item.get("text") or "").strip()
            if text:
                parts.append(text)
    return " ".join(parts).strip()


def _google_tts_access_token() -> tuple[str, str]:
    import google.auth
    from google.auth.transport.requests import Request

    credentials, project_id = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
    credentials.refresh(Request())
    return credentials.token, project_id or ""


def _google_tts_language_code(target_language_code: str | None) -> str:
    target = _safe_language(target_language_code, "en")
    override = os.environ.get(f"GOOGLE_TTS_LANGUAGE_CODE_{target.upper().replace('-', '_')}")
    if override:
        return override
    mapping = {
        "en": "en-US",
        "de": "de-DE",
        "es": "es-ES",
        "fr": "fr-FR",
        "pt": "pt-BR",
        "pt-BR": "pt-BR",
        "pt-PT": "pt-BR",
    }
    if target in mapping:
        return mapping[target]
    if "-" in target:
        return target
    return GOOGLE_TTS_DEFAULT_LANGUAGE_CODE


def _google_voice_cloning_key(voice_alias: str | None = None) -> str:
    return GOOGLE_TTS_VOICE_CLONING_KEY.strip()


def _blocked_clone_result(
    *,
    provider: str,
    provider_mode: str | None,
    session_id: str,
    prefix: str,
    target_language_code: str,
    status: str,
    reason: str,
    missing: list[str] | None = None,
    blockers: list[str] | None = None,
    next_steps: list[str] | None = None,
    fallback_audio_path: str | None = None,
    target_cloned_audio_path: str | None = None,
    preflight: dict | None = None,
    external_api_called: bool = False,
    provider_http_status: int | None = None,
    provider_error_message: str | None = None,
    provider_error_sample: str | None = None,
    provider_error_code: str | None = None,
    provider_error_type: str | None = None,
    provider_error_status: str | None = None,
) -> dict:
    return {
        "status": status,
        "provider": provider,
        "provider_mode": provider_mode,
        "session_id": session_id,
        "prefix": prefix,
        "target_language_code": target_language_code,
        "external_api_called": external_api_called,
        "saved_cloned_audio": False,
        "target_cloned_audio_path": target_cloned_audio_path,
        "fallback_audio_path": fallback_audio_path,
        "fallback_active": True,
        "fallback_reason": reason,
        "missing": missing or [],
        "blockers": blockers or [reason],
        "next_steps": next_steps or [],
        "preflight": preflight,
        "provider_http_status": provider_http_status,
        "provider_error_message": provider_error_message,
        "provider_error_sample": provider_error_sample,
        "provider_error_code": provider_error_code,
        "provider_error_type": provider_error_type,
        "provider_error_status": provider_error_status,
        "created_at": _now_iso(),
    }


def _elevenlabs_http_error_details(response, provider_mode: str | None) -> dict:
    endpoint_label = (
        "Instant Voice Clone"
        if provider_mode == "voice_create"
        else "Speech to Speech"
        if provider_mode == "speech_to_speech"
        else "Text to Speech"
    )
    status_code = int(getattr(response, "status_code", 0) or 0)
    provider_detail = _provider_error_detail(response)
    provider_code = provider_detail.get("code") or ""
    provider_type = provider_detail.get("type") or ""
    if provider_code == "paid_plan_required" or provider_type == "payment_required":
        return {
            "reason": "elevenlabs_paid_plan_required",
            "message": "ElevenLabs paid plan required for this API feature.",
            "next_steps": [
                f"Upgrade the ElevenLabs workspace/API key to a plan that includes {endpoint_label}, or use an existing approved voice_id from a workspace that has this feature.",
                "No source-audio length change can fix this specific provider response.",
            ],
            "provider_error_code": provider_code,
            "provider_error_type": provider_type,
            "provider_error_status": provider_detail.get("status") or "",
        }
    if status_code == 401:
        return {
            "reason": "elevenlabs_invalid_api_key",
            "message": "Invalid ElevenLabs API key.",
            "next_steps": [
                "Verify ELEVENLABS_API_KEY in Secret Manager, expose the latest secret version to otmega-console, then redeploy the console.",
            ],
        }
    if status_code == 403:
        return {
            "reason": "elevenlabs_forbidden_or_restricted_key",
            "message": "Access forbidden or API key restriction issue.",
            "next_steps": [
                f"Enable {endpoint_label} access on the ElevenLabs API key and check key restrictions, workspace access, and account permissions.",
            ],
        }
    if status_code == 429:
        return {
            "reason": "elevenlabs_rate_limit_or_quota",
            "message": "Rate limit or quota issue.",
            "next_steps": [
                "Check ElevenLabs credits, free-tier quota, usage limits, and retry after the provider limit resets.",
            ],
        }
    if status_code == 404:
        return {
            "reason": "elevenlabs_voice_not_found_or_endpoint",
            "message": "ElevenLabs voice_id was not found or the endpoint is not available for this key.",
            "next_steps": [
                f"Verify the approved ElevenLabs voice_id, enable {endpoint_label} access on the API key, and check that the voice belongs to the same ElevenLabs workspace.",
            ],
        }
    if provider_mode == "voice_create" and status_code in {400, 422}:
        return {
            "reason": "elevenlabs_voice_create_validation_error",
            "message": "ElevenLabs rejected the Instant Voice Clone request.",
            "next_steps": [
                "Use a clearer and longer source sample for the speaker; ElevenLabs recommends about 1-2 minutes for Instant Voice Cloning.",
                "Check that the sample has one speaker, low noise, and that the API key has Voices/Voice Generation access.",
            ],
        }
    if status_code >= 500:
        return {
            "reason": "elevenlabs_provider_server_error",
            "message": "ElevenLabs provider server error.",
            "next_steps": [
                "Retry later and check ElevenLabs status/account logs if the provider keeps returning 5xx.",
            ],
        }
    return {
        "reason": "elevenlabs_api_error",
        "message": "ElevenLabs API error.",
        "next_steps": [
            f"Check ELEVENLABS_API_KEY, voice_id, {endpoint_label} access, quota, and provider error detail in clone_result.json or voice_profile_result.json.",
        ],
    }


def _source_voice_clone_providers() -> dict:
    google_adc_available = bool(
        os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
        or os.environ.get("GOOGLE_CLOUD_PROJECT")
        or os.environ.get("GCLOUD_PROJECT")
        or os.environ.get("K_SERVICE")
    )
    google_profile_configured = bool(
        os.environ.get("GOOGLE_TTS_CUSTOM_VOICE_NAME")
        or os.environ.get("GOOGLE_TTS_INSTANT_CUSTOM_VOICE_NAME")
        or os.environ.get("GOOGLE_CUSTOM_VOICE_NAME")
    )
    google_voice_key_configured = bool(GOOGLE_TTS_VOICE_CLONING_KEY.strip())
    google_ready = bool(google_adc_available and (google_profile_configured or google_voice_key_configured))
    elevenlabs_key_configured = bool(os.environ.get("ELEVENLABS_API_KEY"))
    return {
        "google": {
            "label": "Google clone",
            "execution_wired": True,
            "credential_configured": google_adc_available,
            "credential_hint": "Cloud Run ADC or GOOGLE_APPLICATION_CREDENTIALS",
            "profile_configured": google_profile_configured or google_voice_key_configured,
            "profile_hint": "GOOGLE_TTS_VOICE_CLONING_KEY containing an approved Chirp Instant Custom Voice voiceCloningKey",
            "required_secret_env": None,
            "fallback_to": "none_current_live_translate_audio",
            "fallback_reason": None if google_ready else "google_voice_cloning_key_or_adc_missing",
            "status": "ready" if google_ready else "fallback_active",
        },
        "elevenlabs": {
            "label": "ElevenLabs clone",
            "execution_wired": True,
            "credential_configured": elevenlabs_key_configured,
            "credential_hint": "ELEVENLABS_API_KEY",
            "required_secret_env": "ELEVENLABS_API_KEY",
            "fallback_to": "none_current_live_translate_audio",
            "fallback_reason": None if elevenlabs_key_configured else "elevenlabs_api_key_missing",
            "status": "ready" if elevenlabs_key_configured else "fallback_active",
        },
    }


def _clone_provider_preflight(
    provider_key: str,
    provider_mode: str | None,
    target_language_code: str | None,
    voice_alias: str | None = None,
) -> tuple[dict, int]:
    providers = _source_voice_clone_providers()
    provider = providers.get(provider_key)
    if provider_key == "none":
        return {
            "status": "ok",
            "provider": "none",
            "provider_mode": provider_mode,
            "target_language_code": target_language_code or "auto",
            "ready": True,
            "can_execute": False,
            "fallback_active": False,
            "fallback_to": None,
            "fallback_reason": None,
            "missing": [],
            "blockers": [],
            "next_steps": ["Current Live Translate path is active; no clone provider is selected."],
            "checked_at": datetime.now(timezone.utc).isoformat(),
        }, 200
    if not provider:
        return {
            "status": "error",
            "message": "Unsupported clone provider.",
            "provider": provider_key,
            "allowed_providers": ["none", "google", "elevenlabs"],
        }, 400

    missing = []
    blockers = []
    next_steps = []
    if provider_key == "google":
        allowed_modes = {"chirp_instant_custom_voice"}
        if provider_mode not in allowed_modes:
            blockers.append("google_provider_mode_invalid")
            next_steps.append("Select Chirp Instant Custom Voice for real Google voice clone execution.")
        if not provider.get("credential_configured"):
            missing.append("Google ADC")
            blockers.append("google_adc_missing")
            next_steps.append("Run the console on Cloud Run ADC or configure GOOGLE_APPLICATION_CREDENTIALS for Cloud Text-to-Speech.")
        if not _google_voice_cloning_key(voice_alias):
            missing.append("Google voiceCloningKey")
            blockers.append("google_voice_cloning_key_missing")
            next_steps.append("Create/obtain an approved Chirp Instant Custom Voice voiceCloningKey, then set GOOGLE_TTS_VOICE_CLONING_KEY on the backend.")
        if not GOOGLE_TTS_PROJECT_ID:
            next_steps.append("Set GOOGLE_TTS_PROJECT_ID when the ADC project is not the billed Text-to-Speech project.")
    elif provider_key == "elevenlabs":
        allowed_modes = {"speech_to_speech", "transcript_tts"}
        if provider_mode not in allowed_modes:
            blockers.append("elevenlabs_provider_mode_invalid")
            next_steps.append("Select Speech-to-speech or Transcript TTS for ElevenLabs.")
        if not provider.get("credential_configured"):
            missing.append("ELEVENLABS_API_KEY")
            blockers.append("elevenlabs_api_key_missing")
            next_steps.append("Create ELEVENLABS_API_KEY in Secret Manager and expose it to the otmega-console Cloud Run service.")
        if not _safe_voice_reference(voice_alias):
            missing.append("ElevenLabs voice_id")
            blockers.append("elevenlabs_voice_id_missing")
            next_steps.append("Paste an approved ElevenLabs voice_id before Run clone; placeholder text is not a voice_id.")
    elif not provider.get("credential_configured"):
        required_secret = provider.get("required_secret_env")
        missing.append(required_secret or provider.get("credential_hint") or "provider credential")
        next_steps.append(f"Configure {required_secret or provider.get('credential_hint') or 'provider credential'} before enabling execution.")
    if not provider.get("execution_wired"):
        blockers.append(provider.get("fallback_reason") or "provider_execution_not_connected_yet")
        next_steps.append("Provider execution is guarded until the required profile/API path is configured.")

    can_execute = bool(provider.get("credential_configured") and provider.get("execution_wired") and not missing and not blockers)
    fallback_reason = None
    if not can_execute:
        fallback_reason = blockers[0] if blockers else missing[0] if missing else provider.get("fallback_reason")
    return {
        "status": "ok",
        "provider": provider_key,
        "provider_label": provider.get("label"),
        "provider_mode": provider_mode,
        "target_language_code": target_language_code or "auto",
        "ready": can_execute,
        "can_execute": can_execute,
        "fallback_active": not can_execute,
        "fallback_to": None if can_execute else provider.get("fallback_to"),
        "fallback_reason": fallback_reason,
        "credential_configured": bool(provider.get("credential_configured")),
        "execution_wired": bool(provider.get("execution_wired")),
        "missing": missing,
        "blockers": blockers,
        "next_steps": next_steps,
        "checked_at": datetime.now(timezone.utc).isoformat(),
    }, 200


def _blob_exists(bucket, path: str) -> bool:
    return bool(bucket.blob(path).exists())


def _clone_storage_audit(bucket, prefix: str) -> dict:
    def blob_status(name: str) -> dict:
        path = f"{prefix}/{name}"
        try:
            blob = bucket.blob(path)
            exists = bool(blob.exists())
            if exists and getattr(blob, "size", None) is None and hasattr(blob, "reload"):
                blob.reload()
            return {
                "path": path,
                "exists": exists,
                "size": getattr(blob, "size", None) if exists else None,
                "content_type": getattr(blob, "content_type", None) if exists else None,
            }
        except Exception as exc:
            return {"path": path, "exists": None, "error": f"{type(exc).__name__}: {exc}"}

    return {
        "checked_at": _now_iso(),
        "objects": {
            name: blob_status(name)
            for name in [
                "session.json",
                "source.wav",
                "target.wav",
                "input_transcript.json",
                "output_transcript.json",
                "target_cloned.mp3",
                "target_cloned.wav",
                "clone_result.json",
                "voice_profile_result.json",
            ]
        },
    }


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
            "runtime_controls": {
                "audio_chunk_ms": {"default": 250, "min": 100, "max": 500, "step": 50},
                "response_drain_ms": {"default": 6000, "min": 3000, "max": 12000, "step": 500},
                "silence_duration_ms": {"default": 900, "min": 300, "max": 2000, "step": 100},
                "prefix_padding_ms": {"default": 250, "min": 0, "max": 1000, "step": 50},
                "start_sensitivity": ["START_SENSITIVITY_HIGH", "START_SENSITIVITY_LOW"],
                "end_sensitivity": ["END_SENSITIVITY_HIGH", "END_SENSITIVITY_LOW"],
                "activity_handling": ["START_OF_ACTIVITY_INTERRUPTS", "NO_INTERRUPTION"],
                "turn_coverage": ["TURN_INCLUDES_ONLY_ACTIVITY", "TURN_INCLUDES_ALL_INPUT"],
                "transcription": ["inputAudioTranscription", "outputAudioTranscription"],
                "source_voice_clone_modes": ["none", "google", "elevenlabs"],
                "source_voice_clone_execution": {
                    "none": "current_live_translate_audio_path",
                    "google": "wired_with_google_tts_voice_cloning_key",
                    "elevenlabs": "wired_with_api_key_and_voice_id",
                },
                "source_voice_clone_providers": _source_voice_clone_providers(),
                "fixed": {"response_modalities": ["AUDIO"], "input_sample_rate_hz": 16000, "output_sample_rate_hz": 24000},
            },
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


@live_translate_bp.post("/api/console/live-translate/source-voice-clone-preflight")
@require_capability("console.use_live_translate")
def live_translate_source_voice_clone_preflight():
    payload = request.get_json(silent=True) or {}
    provider = str(payload.get("provider") or "none").strip().lower()
    provider_mode = str(payload.get("provider_mode") or "").strip() or None
    target_language_code = str(payload.get("target_language_code") or "").strip() or None
    voice_alias = _safe_voice_reference(payload.get("voice_alias"))
    body, status_code = _clone_provider_preflight(provider, provider_mode, target_language_code, voice_alias or None)
    return jsonify(body), status_code


@live_translate_bp.post("/api/console/live-translate/elevenlabs-voice-profile-create")
@require_capability("console.use_live_translate")
def live_translate_elevenlabs_voice_profile_create():
    payload = request.get_json(silent=True) or {}
    raw_session_id = str(payload.get("session_id") or "").strip()
    if not raw_session_id:
        return jsonify({"status": "error", "message": "session_id is required before creating an ElevenLabs voice profile."}), 400
    session_id = _safe_session_id(raw_session_id)
    speaker_email = _safe_speaker_email(payload.get("speaker_email"))
    consent_version = str(payload.get("consent_version") or "").strip()[:120]
    remove_background_noise = bool(payload.get("remove_background_noise", False))
    prefix = f"{SESSION_PREFIX}/{session_id}"
    source_audio_path = f"{prefix}/source.wav"
    voice_profile_result_path = f"{prefix}/voice_profile_result.json"
    now = _now_iso()

    missing = []
    blockers = []
    next_steps = []
    api_key = os.environ.get("ELEVENLABS_API_KEY") or ""
    if not api_key:
        missing.append("ELEVENLABS_API_KEY")
        blockers.append("elevenlabs_api_key_missing")
        next_steps.append("Create ELEVENLABS_API_KEY in Secret Manager and expose it to the otmega-console Cloud Run service.")
    if not speaker_email:
        missing.append("speaker email")
        blockers.append("speaker_email_invalid")
        next_steps.append("Enter the speaker email; the email is used as the saved voice profile label.")
    if not consent_version:
        missing.append("voice consent")
        blockers.append("voice_consent_missing")
        next_steps.append("Set a consent marker such as voice-consent-v1 after confirming the speaker consent is already handled.")

    bucket = _storage_client().bucket(BUCKET_NAME)

    def persist_voice_profile_result(result: dict) -> dict:
        result["voice_profile_result_path"] = voice_profile_result_path
        result["saved_paths"] = [voice_profile_result_path]
        try:
            result["storage_audit"] = _clone_storage_audit(bucket, prefix)
            _upload_text_blob(bucket, voice_profile_result_path, result)
        except Exception as exc:
            logger.warning(
                "[LiveTranslate] voice_profile_result persist failed session_id=%s error=%s",
                session_id,
                exc,
            )
            result["saved_paths"] = []
            result["persist_error"] = f"{type(exc).__name__}: {exc}"
        return result

    session_payload = _read_json_blob(bucket, f"{prefix}/session.json")
    source_seconds = None
    if isinstance(session_payload, dict):
        metadata = session_payload.get("metadata")
        monitor = metadata.get("monitor") if isinstance(metadata, dict) else None
        raw_source_seconds = monitor.get("sourceSeconds") if isinstance(monitor, dict) else None
        try:
            source_seconds = float(raw_source_seconds) if raw_source_seconds is not None else None
        except (TypeError, ValueError):
            source_seconds = None

    source_blob = bucket.blob(source_audio_path)
    if not source_blob.exists():
        missing.append("source.wav")
        blockers.append("source_audio_missing")
        next_steps.append("Save or restore a Live Translate session that has Source audio before creating an ElevenLabs voice profile.")
    elif source_blob.size is None:
        source_blob.reload()
    if source_blob.exists() and source_blob.size and source_blob.size > CLONE_MAX_AUDIO_BYTES:
        blockers.append("source_audio_too_large")
        next_steps.append(f"Use a shorter source sample; max allowed for console clone setup is {CLONE_MAX_AUDIO_BYTES} bytes.")
    if source_blob.exists() and source_seconds is None and source_blob.size:
        source_seconds = max(0.0, round((source_blob.size - 44) / 32000, 1))
    if source_blob.exists() and source_seconds is not None and source_seconds < ELEVENLABS_IVC_MIN_SOURCE_SECONDS:
        blockers.append("source_audio_too_short_for_ivc")
        next_steps.append(
            f"Record a longer source sample before Create voice_id; minimum console guard is {ELEVENLABS_IVC_MIN_SOURCE_SECONDS:g}s and ElevenLabs recommends about 1-2 minutes for Instant Voice Cloning."
        )

    if blockers:
        return jsonify(persist_voice_profile_result({
            "status": "blocked",
            "provider": "elevenlabs",
            "speaker_email": speaker_email,
            "session_id": session_id,
            "prefix": prefix,
            "source_audio_path": source_audio_path,
            "source_seconds": source_seconds,
            "min_source_seconds": ELEVENLABS_IVC_MIN_SOURCE_SECONDS,
            "external_api_called": False,
            "missing": missing,
            "blockers": blockers,
            "next_steps": next_steps,
            "created_at": now,
        }))

    try:
        source_audio = source_blob.download_as_bytes()
        import requests

        response = requests.post(
            f"{ELEVENLABS_API_BASE}/voices/add",
            headers={"xi-api-key": api_key},
            data={
                "name": speaker_email,
                "description": f"OTMEGA Collabra voice profile for {speaker_email}; consent={consent_version}; source_session={session_id}",
                "remove_background_noise": "true" if remove_background_noise else "false",
            },
            files=[("files[]", ("source.wav", source_audio, source_blob.content_type or "audio/wav"))],
            timeout=CLONE_HTTP_TIMEOUT_SECONDS,
        )
    except Exception as exc:
        logger.exception("[LiveTranslate] ElevenLabs voice profile create request failed session_id=%s email=%s", session_id, speaker_email)
        return jsonify(persist_voice_profile_result({
            "status": "failed",
            "provider": "elevenlabs",
            "speaker_email": speaker_email,
            "session_id": session_id,
            "prefix": prefix,
            "source_audio_path": source_audio_path,
            "source_seconds": source_seconds,
            "min_source_seconds": ELEVENLABS_IVC_MIN_SOURCE_SECONDS,
            "external_api_called": True,
            "fallback_reason": "elevenlabs_voice_create_request_failed",
            "blockers": ["elevenlabs_voice_create_request_failed"],
            "next_steps": ["Check network access from Cloud Run to ElevenLabs, provider timeout, and ELEVENLABS_API_BASE."],
            "provider_error_message": f"{type(exc).__name__}: {exc}",
            "created_at": now,
        }))

    if not response.ok:
        details = _elevenlabs_http_error_details(response, "voice_create")
        sample = (response.text or "")[:500]
        logger.warning(
            "[LiveTranslate] ElevenLabs voice profile create API error session_id=%s email=%s status=%s reason=%s sample=%s",
            session_id,
            speaker_email,
            response.status_code,
            details["reason"],
            sample,
        )
        return jsonify(persist_voice_profile_result({
            "status": "failed",
            "provider": "elevenlabs",
            "speaker_email": speaker_email,
            "session_id": session_id,
            "prefix": prefix,
            "source_audio_path": source_audio_path,
            "source_seconds": source_seconds,
            "min_source_seconds": ELEVENLABS_IVC_MIN_SOURCE_SECONDS,
            "external_api_called": True,
            "fallback_reason": details["reason"],
            "blockers": [details["reason"]],
            "next_steps": details["next_steps"],
            "provider_http_status": response.status_code,
            "provider_error_message": details["message"],
            "provider_error_sample": sample,
            "provider_error_code": details.get("provider_error_code"),
            "provider_error_type": details.get("provider_error_type"),
            "provider_error_status": details.get("provider_error_status"),
            "created_at": now,
        }))

    try:
        provider_payload = response.json()
    except Exception:
        provider_payload = {}
    voice_id = str(provider_payload.get("voice_id") or "").strip()
    if not voice_id:
        return jsonify(persist_voice_profile_result({
            "status": "failed",
            "provider": "elevenlabs",
            "speaker_email": speaker_email,
            "session_id": session_id,
            "prefix": prefix,
            "source_audio_path": source_audio_path,
            "source_seconds": source_seconds,
            "min_source_seconds": ELEVENLABS_IVC_MIN_SOURCE_SECONDS,
            "external_api_called": True,
            "fallback_reason": "elevenlabs_voice_create_missing_voice_id",
            "blockers": ["elevenlabs_voice_create_missing_voice_id"],
            "next_steps": ["Review ElevenLabs response/account history; the create voice endpoint returned success without voice_id."],
            "provider_error_sample": (response.text or "")[:500],
            "created_at": now,
        }))

    return jsonify(persist_voice_profile_result({
        "status": "completed",
        "provider": "elevenlabs",
        "speaker_email": speaker_email,
        "voice_id": voice_id,
        "requires_verification": bool(provider_payload.get("requires_verification", False)),
        "consent_version": consent_version,
        "session_id": session_id,
        "prefix": prefix,
        "source_audio_path": source_audio_path,
        "source_seconds": source_seconds,
        "min_source_seconds": ELEVENLABS_IVC_MIN_SOURCE_SECONDS,
        "external_api_called": True,
        "created_at": now,
    }))


@live_translate_bp.post("/api/console/live-translate/source-voice-clone-plan")
@require_capability("console.use_live_translate")
def live_translate_source_voice_clone_plan():
    payload = request.get_json(silent=True) or {}
    raw_session_id = str(payload.get("session_id") or "").strip()
    if not raw_session_id:
        return jsonify({"status": "error", "message": "session_id is required before preparing a clone plan."}), 400
    session_id = _safe_session_id(raw_session_id)
    provider = str(payload.get("provider") or "none").strip().lower()
    provider_mode = str(payload.get("provider_mode") or "").strip() or None
    target_language_code = _safe_language(payload.get("target_language_code"), "en")
    prefix = f"{SESSION_PREFIX}/{session_id}"

    voice_alias = _safe_voice_reference(payload.get("voice_alias"))
    preflight, preflight_status = _clone_provider_preflight(provider, provider_mode, target_language_code, voice_alias or None)
    if preflight_status >= 400:
        return jsonify(preflight), preflight_status

    try:
        client = _storage_client()
        bucket = client.bucket(BUCKET_NAME)
        if not _blob_exists(bucket, f"{prefix}/session.json"):
            return jsonify({"status": "error", "message": f"Session {session_id} was not found."}), 404

        source_audio_path = f"{prefix}/source.wav"
        target_audio_path = f"{prefix}/target.wav"
        output_transcript_path = f"{prefix}/output_transcript.json"
        target_cloned_audio_path = f"{prefix}/target_cloned.{_clone_output_extension(provider)}"
        clone_result_path = f"{prefix}/clone_result.json"
        clone_plan_path = f"{prefix}/clone_plan.json"
        source_audio_exists = _blob_exists(bucket, source_audio_path)
        target_audio_exists = _blob_exists(bucket, target_audio_path)
        output_transcript_exists = _blob_exists(bucket, output_transcript_path)

        missing = list(preflight.get("missing") or [])
        blockers = list(preflight.get("blockers") or [])
        if provider != "none" and not source_audio_exists:
            missing.append("source.wav")
            blockers.append("source_audio_missing")
        if provider != "none" and not target_audio_exists and not output_transcript_exists:
            missing.append("target.wav or output_transcript.json")
            blockers.append("target_audio_or_output_transcript_missing")

        can_execute = bool(preflight.get("can_execute")) and not blockers
        plan = {
            "status": "ready_for_provider_execution" if can_execute else "blocked_fallback_to_no_clone",
            "external_api_called": False,
            "provider": provider,
            "provider_mode": provider_mode,
            "target_language_code": target_language_code,
            "session_id": session_id,
            "prefix": prefix,
            "preflight": preflight,
            "inputs": {
                "source_audio_path": source_audio_path,
                "source_audio_exists": source_audio_exists,
                "target_audio_path": target_audio_path,
                "target_audio_exists": target_audio_exists,
                "output_transcript_path": output_transcript_path,
                "output_transcript_exists": output_transcript_exists,
            },
            "outputs": {
                "target_cloned_audio_path": target_cloned_audio_path,
                "clone_result_path": clone_result_path,
                "fallback_audio_path": target_audio_path,
            },
            "controls": {
                "voice_alias": voice_alias or None,
                "consent_version": str(payload.get("consent_version") or "").strip() or None,
                "save_cloned_audio": bool(payload.get("save_cloned_audio", True)),
                "fallback_to_live_translate_audio": bool(payload.get("fallback_to_live_translate_audio", True)),
            },
            "missing": missing,
            "blockers": blockers,
            "next_steps": list(preflight.get("next_steps") or []),
            "created_at": _now_iso(),
        }
        _upload_text_blob(bucket, clone_plan_path, plan)
    except ImportError:
        return jsonify({"status": "error", "message": "google-cloud-storage is not installed."}), 500
    except Exception as exc:
        return jsonify({"status": "error", "message": f"Live Translate clone plan failed: {type(exc).__name__}: {exc}"}), 502

    return jsonify({"status": "ok", "bucket": BUCKET_NAME, "session_id": session_id, "prefix": prefix, "plan": plan, "saved_paths": [clone_plan_path]})


@live_translate_bp.post("/api/console/live-translate/source-voice-clone-execute")
@require_capability("console.use_live_translate")
def live_translate_source_voice_clone_execute():
    payload = request.get_json(silent=True) or {}
    raw_session_id = str(payload.get("session_id") or "").strip()
    if not raw_session_id:
        return jsonify({"status": "error", "message": "session_id is required before running clone."}), 400

    session_id = _safe_session_id(raw_session_id)
    provider = str(payload.get("provider") or "none").strip().lower()
    provider_mode = str(payload.get("provider_mode") or "").strip() or None
    target_language_code = _safe_language(payload.get("target_language_code"), "en")
    voice_alias = _safe_voice_reference(payload.get("voice_alias"))
    consent_version = str(payload.get("consent_version") or "").strip() or None
    save_cloned_audio = bool(payload.get("save_cloned_audio", True))
    fallback_to_live_translate_audio = bool(payload.get("fallback_to_live_translate_audio", True))
    client_context = payload.get("client_context") if isinstance(payload.get("client_context"), dict) else {}
    prefix = f"{SESSION_PREFIX}/{session_id}"
    source_audio_path = f"{prefix}/source.wav"
    target_audio_path = f"{prefix}/target.wav"
    output_transcript_path = f"{prefix}/output_transcript.json"
    target_cloned_audio_path = f"{prefix}/target_cloned.{_clone_output_extension(provider)}"
    clone_result_path = f"{prefix}/clone_result.json"
    saved_paths: list[str] = []
    external_api_attempted = False

    preflight, preflight_status = _clone_provider_preflight(provider, provider_mode, target_language_code, voice_alias or None)
    if preflight_status >= 400:
        return jsonify(preflight), preflight_status

    try:
        client = _storage_client()
        bucket = client.bucket(BUCKET_NAME)
        if not _blob_exists(bucket, f"{prefix}/session.json"):
            return jsonify({"status": "error", "message": f"Session {session_id} was not found."}), 404

        def persist_clone_result(result: dict) -> None:
            result["storage_audit"] = _clone_storage_audit(bucket, prefix)
            if client_context:
                result["client_context"] = client_context
            _upload_text_blob(bucket, clone_result_path, result)

        if provider == "none":
            result = _blocked_clone_result(
                provider=provider,
                provider_mode=provider_mode,
                session_id=session_id,
                prefix=prefix,
                target_language_code=target_language_code,
                status="skipped_no_clone_selected",
                reason="no_clone_selected",
                blockers=["no_clone_selected"],
                next_steps=["Select Google clone or ElevenLabs clone before Run clone."],
                fallback_audio_path=target_audio_path,
                target_cloned_audio_path=target_cloned_audio_path,
                preflight=preflight,
            )
            persist_clone_result(result)
            return jsonify({"status": "ok", "bucket": BUCKET_NAME, "session_id": session_id, "prefix": prefix, "result": result, "saved_paths": [clone_result_path]})

        if provider not in {"google", "elevenlabs"}:
            return jsonify({"status": "error", "message": "Unsupported clone provider.", "allowed_providers": ["none", "google", "elevenlabs"]}), 400

        missing = list(preflight.get("missing") or [])
        blockers = list(preflight.get("blockers") or [])
        next_steps = list(preflight.get("next_steps") or [])
        if not save_cloned_audio:
            blockers.append("save_cloned_audio_disabled")
            next_steps.append("Turn on Save clone audio before Run clone.")
        if not fallback_to_live_translate_audio:
            next_steps.append("Fallback audio is disabled; clone failure will leave only clone_result.json.")

        if missing or blockers:
            result = _blocked_clone_result(
                provider=provider,
                provider_mode=provider_mode,
                session_id=session_id,
                prefix=prefix,
                target_language_code=target_language_code,
                status="blocked_fallback_to_no_clone",
                reason=blockers[0] if blockers else missing[0],
                missing=missing,
                blockers=blockers,
                next_steps=next_steps,
                fallback_audio_path=target_audio_path,
                target_cloned_audio_path=target_cloned_audio_path,
                preflight=preflight,
            )
            persist_clone_result(result)
            return jsonify({"status": "ok", "bucket": BUCKET_NAME, "session_id": session_id, "prefix": prefix, "result": result, "saved_paths": [clone_result_path]})

        provider_http_status = None
        output_bytes = b""
        output_content_type = "audio/mpeg"
        provider_model_id = ""
        provider_output_format = ""
        import requests
        requested_provider_mode = provider_mode
        mode_fallback_reason = None

        if provider == "elevenlabs" and provider_mode == "speech_to_speech" and not _blob_exists(bucket, target_audio_path):
            fallback_text = _output_transcript_text(bucket, output_transcript_path)
            if fallback_text:
                provider_mode = "transcript_tts"
                mode_fallback_reason = "target_audio_missing_transcript_tts_fallback"
                preflight = {
                    **preflight,
                    "requested_provider_mode": requested_provider_mode,
                    "effective_provider_mode": provider_mode,
                    "mode_fallback_reason": mode_fallback_reason,
                }
                logger.info(
                    "[LiveTranslate] ElevenLabs mode fallback session_id=%s requested=%s effective=%s reason=%s",
                    session_id,
                    requested_provider_mode,
                    provider_mode,
                    mode_fallback_reason,
                )

        if provider == "google":
            transcript_text = _output_transcript_text(bucket, output_transcript_path)
            if not transcript_text:
                result = _blocked_clone_result(
                    provider=provider,
                    provider_mode=provider_mode,
                    session_id=session_id,
                    prefix=prefix,
                    target_language_code=target_language_code,
                    status="blocked_fallback_to_no_clone",
                    reason="output_transcript_missing",
                    missing=["output_transcript.json text"],
                    blockers=["output_transcript_missing"],
                    next_steps=["Save a Live Translate session with output transcript before Google clone."],
                    fallback_audio_path=target_audio_path,
                    target_cloned_audio_path=target_cloned_audio_path,
                    preflight=preflight,
                )
                persist_clone_result(result)
                return jsonify({"status": "ok", "bucket": BUCKET_NAME, "session_id": session_id, "prefix": prefix, "result": result, "saved_paths": [clone_result_path]})
            if len(transcript_text) > CLONE_MAX_TEXT_CHARS:
                result = _blocked_clone_result(
                    provider=provider,
                    provider_mode=provider_mode,
                    session_id=session_id,
                    prefix=prefix,
                    target_language_code=target_language_code,
                    status="blocked_fallback_to_no_clone",
                    reason="output_transcript_over_cost_guard",
                    blockers=["output_transcript_over_cost_guard"],
                    next_steps=[f"Use transcript under {CLONE_MAX_TEXT_CHARS} characters or raise LIVE_TRANSLATE_CLONE_MAX_TEXT_CHARS intentionally."],
                    fallback_audio_path=target_audio_path,
                    target_cloned_audio_path=target_cloned_audio_path,
                    preflight=preflight,
                )
                persist_clone_result(result)
                return jsonify({"status": "ok", "bucket": BUCKET_NAME, "session_id": session_id, "prefix": prefix, "result": result, "saved_paths": [clone_result_path]})

            voice_key = _google_voice_cloning_key(voice_alias)
            access_token, adc_project_id = _google_tts_access_token()
            billed_project_id = GOOGLE_TTS_PROJECT_ID or adc_project_id
            language_code = _google_tts_language_code(target_language_code)
            headers = {"Authorization": f"Bearer {access_token}", "Content-Type": "application/json; charset=utf-8"}
            if billed_project_id:
                headers["x-goog-user-project"] = billed_project_id
            body = {
                "input": {"text": transcript_text},
                "voice": {
                    "language_code": language_code,
                    "voice_clone": {"voice_cloning_key": voice_key},
                },
                "audioConfig": {
                    "audioEncoding": GOOGLE_TTS_OUTPUT_ENCODING,
                    "sampleRateHertz": 24000,
                },
            }
            external_api_attempted = True
            response = requests.post(
                f"{GOOGLE_TTS_API_BASE}/v1beta1/text:synthesize",
                headers=headers,
                json=body,
                timeout=CLONE_HTTP_TIMEOUT_SECONDS,
            )
            provider_http_status = response.status_code
            if not response.ok:
                result = _blocked_clone_result(
                    provider=provider,
                    provider_mode=provider_mode,
                    session_id=session_id,
                    prefix=prefix,
                    target_language_code=target_language_code,
                    status="failed_fallback_to_no_clone",
                    reason="google_tts_api_error",
                    blockers=["google_tts_api_error"],
                    next_steps=["Check Google ADC/project billing, Text-to-Speech API enablement, Chirp Instant Custom Voice allowlist, voiceCloningKey, and target language support."],
                    fallback_audio_path=target_audio_path,
                    target_cloned_audio_path=target_cloned_audio_path,
                    preflight=preflight,
                    external_api_called=True,
                    provider_http_status=provider_http_status,
                    provider_error_sample=response.text[:800],
                )
                persist_clone_result(result)
                return jsonify({"status": "ok", "bucket": BUCKET_NAME, "session_id": session_id, "prefix": prefix, "result": result, "saved_paths": [clone_result_path]})
            response_json = response.json()
            audio_content = str(response_json.get("audioContent") or "")
            if not audio_content:
                result = _blocked_clone_result(
                    provider=provider,
                    provider_mode=provider_mode,
                    session_id=session_id,
                    prefix=prefix,
                    target_language_code=target_language_code,
                    status="failed_fallback_to_no_clone",
                    reason="google_tts_audio_content_missing",
                    blockers=["google_tts_audio_content_missing"],
                    next_steps=["Review clone_result.json and Cloud Run logs; Google TTS returned success without audioContent."],
                    fallback_audio_path=target_audio_path,
                    target_cloned_audio_path=target_cloned_audio_path,
                    preflight=preflight,
                    external_api_called=True,
                    provider_http_status=provider_http_status,
                )
                persist_clone_result(result)
                return jsonify({"status": "ok", "bucket": BUCKET_NAME, "session_id": session_id, "prefix": prefix, "result": result, "saved_paths": [clone_result_path]})
            output_bytes = base64.b64decode(audio_content)
            output_content_type = "audio/wav"
            provider_model_id = "chirp_3_instant_custom_voice"
            provider_output_format = GOOGLE_TTS_OUTPUT_ENCODING
            preflight = {**preflight, "google_language_code": language_code, "voice_reference_present": bool(voice_key)}
        elif provider_mode == "speech_to_speech":
            api_key = os.environ.get("ELEVENLABS_API_KEY") or ""
            headers = {"xi-api-key": api_key}
            target_audio = _download_blob_bytes(bucket, target_audio_path)
            if not target_audio:
                result = _blocked_clone_result(
                    provider=provider,
                    provider_mode=provider_mode,
                    session_id=session_id,
                    prefix=prefix,
                    target_language_code=target_language_code,
                    status="blocked_fallback_to_no_clone",
                    reason="target_audio_missing",
                    missing=["target.wav"],
                    blockers=["target_audio_missing"],
                    next_steps=["Save a Live Translate session with target audio before Run clone."],
                    fallback_audio_path=target_audio_path,
                    target_cloned_audio_path=target_cloned_audio_path,
                    preflight=preflight,
                )
                persist_clone_result(result)
                return jsonify({"status": "ok", "bucket": BUCKET_NAME, "session_id": session_id, "prefix": prefix, "result": result, "saved_paths": [clone_result_path]})
            if len(target_audio) > CLONE_MAX_AUDIO_BYTES:
                result = _blocked_clone_result(
                    provider=provider,
                    provider_mode=provider_mode,
                    session_id=session_id,
                    prefix=prefix,
                    target_language_code=target_language_code,
                    status="blocked_fallback_to_no_clone",
                    reason="target_audio_over_cost_guard",
                    blockers=["target_audio_over_cost_guard"],
                    next_steps=[f"Use audio under {CLONE_MAX_AUDIO_BYTES} bytes or raise LIVE_TRANSLATE_CLONE_MAX_AUDIO_BYTES intentionally."],
                    fallback_audio_path=target_audio_path,
                    target_cloned_audio_path=target_cloned_audio_path,
                    preflight=preflight,
                )
                persist_clone_result(result)
                return jsonify({"status": "ok", "bucket": BUCKET_NAME, "session_id": session_id, "prefix": prefix, "result": result, "saved_paths": [clone_result_path]})
            external_api_attempted = True
            try:
                response = requests.post(
                    f"{ELEVENLABS_API_BASE}/speech-to-speech/{voice_alias}",
                    params={"output_format": ELEVENLABS_OUTPUT_FORMAT},
                    headers=headers,
                    data={"model_id": ELEVENLABS_STS_MODEL_ID},
                    files={"audio": ("target.wav", target_audio, "audio/wav")},
                    timeout=CLONE_HTTP_TIMEOUT_SECONDS,
                )
            except requests.RequestException as exc:
                logger.exception("[LiveTranslate] ElevenLabs request failed provider_mode=%s session_id=%s", provider_mode, session_id)
                result = _blocked_clone_result(
                    provider=provider,
                    provider_mode=provider_mode,
                    session_id=session_id,
                    prefix=prefix,
                    target_language_code=target_language_code,
                    status="failed_fallback_to_no_clone",
                    reason="elevenlabs_request_exception",
                    blockers=["elevenlabs_request_exception"],
                    next_steps=["Check network access from Cloud Run to ElevenLabs, provider timeout, and ELEVENLABS_API_BASE."],
                    fallback_audio_path=target_audio_path,
                    target_cloned_audio_path=target_cloned_audio_path,
                    preflight=preflight,
                    external_api_called=True,
                    provider_error_message=f"ElevenLabs request failed: {type(exc).__name__}",
                    provider_error_sample=str(exc)[:800],
                )
                persist_clone_result(result)
                return jsonify({"status": "ok", "bucket": BUCKET_NAME, "session_id": session_id, "prefix": prefix, "result": result, "saved_paths": [clone_result_path]})
            provider_http_status = response.status_code
            if response.ok and response.content:
                output_bytes = response.content
                provider_model_id = ELEVENLABS_STS_MODEL_ID
                provider_output_format = ELEVENLABS_OUTPUT_FORMAT
            else:
                if response.ok:
                    error_details = {
                        "reason": "elevenlabs_empty_audio_response",
                        "message": "ElevenLabs returned success without audio content.",
                        "next_steps": ["Retry once, then check voice_id/model support and ElevenLabs history for this request."],
                    }
                else:
                    error_details = _elevenlabs_http_error_details(response, provider_mode)
                logger.warning(
                    "[LiveTranslate] ElevenLabs API error provider_mode=%s session_id=%s status=%s reason=%s sample=%s",
                    provider_mode,
                    session_id,
                    provider_http_status,
                    error_details["reason"],
                    response.text[:200],
                )
                result = _blocked_clone_result(
                    provider=provider,
                    provider_mode=provider_mode,
                    session_id=session_id,
                    prefix=prefix,
                    target_language_code=target_language_code,
                    status="failed_fallback_to_no_clone",
                    reason=error_details["reason"],
                    blockers=[error_details["reason"]],
                    next_steps=error_details["next_steps"],
                    fallback_audio_path=target_audio_path,
                    target_cloned_audio_path=target_cloned_audio_path,
                    preflight=preflight,
                    external_api_called=True,
                    provider_http_status=provider_http_status,
                    provider_error_message=error_details["message"],
                    provider_error_sample=response.text[:800],
                    provider_error_code=error_details.get("provider_error_code"),
                    provider_error_type=error_details.get("provider_error_type"),
                    provider_error_status=error_details.get("provider_error_status"),
                )
                persist_clone_result(result)
                return jsonify({"status": "ok", "bucket": BUCKET_NAME, "session_id": session_id, "prefix": prefix, "result": result, "saved_paths": [clone_result_path]})
        else:
            api_key = os.environ.get("ELEVENLABS_API_KEY") or ""
            headers = {"xi-api-key": api_key}
            transcript_text = _output_transcript_text(bucket, output_transcript_path)
            if not transcript_text:
                result = _blocked_clone_result(
                    provider=provider,
                    provider_mode=provider_mode,
                    session_id=session_id,
                    prefix=prefix,
                    target_language_code=target_language_code,
                    status="blocked_fallback_to_no_clone",
                    reason="output_transcript_missing",
                    missing=["output_transcript.json text"],
                    blockers=["output_transcript_missing"],
                    next_steps=["Save a Live Translate session with output transcript before Transcript TTS clone."],
                    fallback_audio_path=target_audio_path,
                    target_cloned_audio_path=target_cloned_audio_path,
                    preflight=preflight,
                )
                persist_clone_result(result)
                return jsonify({"status": "ok", "bucket": BUCKET_NAME, "session_id": session_id, "prefix": prefix, "result": result, "saved_paths": [clone_result_path]})
            if len(transcript_text) > CLONE_MAX_TEXT_CHARS:
                result = _blocked_clone_result(
                    provider=provider,
                    provider_mode=provider_mode,
                    session_id=session_id,
                    prefix=prefix,
                    target_language_code=target_language_code,
                    status="blocked_fallback_to_no_clone",
                    reason="output_transcript_over_cost_guard",
                    blockers=["output_transcript_over_cost_guard"],
                    next_steps=[f"Use transcript under {CLONE_MAX_TEXT_CHARS} characters or raise LIVE_TRANSLATE_CLONE_MAX_TEXT_CHARS intentionally."],
                    fallback_audio_path=target_audio_path,
                    target_cloned_audio_path=target_cloned_audio_path,
                    preflight=preflight,
                )
                persist_clone_result(result)
                return jsonify({"status": "ok", "bucket": BUCKET_NAME, "session_id": session_id, "prefix": prefix, "result": result, "saved_paths": [clone_result_path]})
            external_api_attempted = True
            try:
                response = requests.post(
                    f"{ELEVENLABS_API_BASE}/text-to-speech/{voice_alias}",
                    params={"output_format": ELEVENLABS_OUTPUT_FORMAT},
                    headers={**headers, "Content-Type": "application/json"},
                    json={"text": transcript_text, "model_id": ELEVENLABS_TTS_MODEL_ID},
                    timeout=CLONE_HTTP_TIMEOUT_SECONDS,
                )
            except requests.RequestException as exc:
                logger.exception("[LiveTranslate] ElevenLabs request failed provider_mode=%s session_id=%s", provider_mode, session_id)
                result = _blocked_clone_result(
                    provider=provider,
                    provider_mode=provider_mode,
                    session_id=session_id,
                    prefix=prefix,
                    target_language_code=target_language_code,
                    status="failed_fallback_to_no_clone",
                    reason="elevenlabs_request_exception",
                    blockers=["elevenlabs_request_exception"],
                    next_steps=["Check network access from Cloud Run to ElevenLabs, provider timeout, and ELEVENLABS_API_BASE."],
                    fallback_audio_path=target_audio_path,
                    target_cloned_audio_path=target_cloned_audio_path,
                    preflight=preflight,
                    external_api_called=True,
                    provider_error_message=f"ElevenLabs request failed: {type(exc).__name__}",
                    provider_error_sample=str(exc)[:800],
                )
                persist_clone_result(result)
                return jsonify({"status": "ok", "bucket": BUCKET_NAME, "session_id": session_id, "prefix": prefix, "result": result, "saved_paths": [clone_result_path]})
            provider_http_status = response.status_code
            if response.ok and response.content:
                output_bytes = response.content
                provider_model_id = ELEVENLABS_TTS_MODEL_ID
                provider_output_format = ELEVENLABS_OUTPUT_FORMAT
            else:
                if response.ok:
                    error_details = {
                        "reason": "elevenlabs_empty_audio_response",
                        "message": "ElevenLabs returned success without audio content.",
                        "next_steps": ["Retry once, then check voice_id/model support and ElevenLabs history for this request."],
                    }
                else:
                    error_details = _elevenlabs_http_error_details(response, provider_mode)
                logger.warning(
                    "[LiveTranslate] ElevenLabs API error provider_mode=%s session_id=%s status=%s reason=%s sample=%s",
                    provider_mode,
                    session_id,
                    provider_http_status,
                    error_details["reason"],
                    response.text[:200],
                )
                result = _blocked_clone_result(
                    provider=provider,
                    provider_mode=provider_mode,
                    session_id=session_id,
                    prefix=prefix,
                    target_language_code=target_language_code,
                    status="failed_fallback_to_no_clone",
                    reason=error_details["reason"],
                    blockers=[error_details["reason"]],
                    next_steps=error_details["next_steps"],
                    fallback_audio_path=target_audio_path,
                    target_cloned_audio_path=target_cloned_audio_path,
                    preflight=preflight,
                    external_api_called=True,
                    provider_http_status=provider_http_status,
                    provider_error_message=error_details["message"],
                    provider_error_sample=response.text[:800],
                    provider_error_code=error_details.get("provider_error_code"),
                    provider_error_type=error_details.get("provider_error_type"),
                    provider_error_status=error_details.get("provider_error_status"),
                )
                persist_clone_result(result)
                return jsonify({"status": "ok", "bucket": BUCKET_NAME, "session_id": session_id, "prefix": prefix, "result": result, "saved_paths": [clone_result_path]})

        _upload_binary_blob(bucket, target_cloned_audio_path, output_bytes, output_content_type)
        saved_paths.append(target_cloned_audio_path)
        if provider == "elevenlabs":
            logger.info(
                "[LiveTranslate] ElevenLabs clone completed provider_mode=%s session_id=%s status=%s output_bytes=%s",
                provider_mode,
                session_id,
                provider_http_status,
                len(output_bytes),
            )
        result = {
            "status": "completed",
            "provider": provider,
            "provider_mode": provider_mode,
            "requested_provider_mode": requested_provider_mode,
            "effective_provider_mode": provider_mode,
            "mode_fallback_reason": mode_fallback_reason,
            "session_id": session_id,
            "prefix": prefix,
            "target_language_code": target_language_code,
            "external_api_called": True,
            "saved_cloned_audio": True,
            "target_cloned_audio_path": target_cloned_audio_path,
            "fallback_audio_path": target_audio_path,
            "fallback_active": False,
            "fallback_reason": None,
            "voice_reference": voice_alias if provider == "elevenlabs" else None,
            "voice_reference_present": bool(voice_alias) if provider == "elevenlabs" else bool(_google_voice_cloning_key(voice_alias)),
            "consent_version": consent_version,
            "provider_http_status": provider_http_status,
            "provider_output_bytes": len(output_bytes),
            "model_id": provider_model_id,
            "output_format": provider_output_format,
            "cost_guard": {
                "max_audio_bytes": CLONE_MAX_AUDIO_BYTES,
                "max_text_chars": CLONE_MAX_TEXT_CHARS,
                "provider_cost_reported_by_api": False,
            },
            "preflight": preflight,
            "created_at": _now_iso(),
        }
        persist_clone_result(result)
        saved_paths.append(clone_result_path)
        return jsonify({"status": "ok", "bucket": BUCKET_NAME, "session_id": session_id, "prefix": prefix, "result": result, "saved_paths": saved_paths})
    except ImportError:
        return jsonify({"status": "error", "message": "Required package is not installed."}), 500
    except Exception as exc:
        logger.exception("[LiveTranslate] source voice clone execute failed provider=%s session_id=%s", provider, session_id)
        try:
            result = _blocked_clone_result(
                provider=provider,
                provider_mode=provider_mode,
                session_id=session_id,
                prefix=prefix,
                target_language_code=target_language_code,
                status="failed_fallback_to_no_clone",
                reason="clone_execution_exception",
                blockers=["clone_execution_exception"],
                next_steps=["Review clone_result.json and Cloud Run logs, then verify provider credential/profile and saved session audio."],
                fallback_audio_path=target_audio_path,
                target_cloned_audio_path=target_cloned_audio_path,
                preflight=preflight,
                external_api_called=external_api_attempted,
                provider_error_sample=f"{type(exc).__name__}: {exc}"[:800],
            )
            client = _storage_client()
            bucket = client.bucket(BUCKET_NAME)
            result["storage_audit"] = _clone_storage_audit(bucket, prefix)
            if client_context:
                result["client_context"] = client_context
            _upload_text_blob(bucket, clone_result_path, result)
            return jsonify({"status": "ok", "bucket": BUCKET_NAME, "session_id": session_id, "prefix": prefix, "result": result, "saved_paths": [clone_result_path]})
        except Exception:
            return jsonify({"status": "error", "message": f"Live Translate clone execute failed: {type(exc).__name__}: {exc}"}), 502


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
        source_audio = _audio_blob_payload(bucket, f"{prefix}/source.wav")
        target_audio = _audio_blob_payload(bucket, f"{prefix}/target.wav")
        target_cloned_audio = _first_audio_blob_payload(bucket, [f"{prefix}/target_cloned.mp3", f"{prefix}/target_cloned.wav"])
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
                "clone_plan": _read_json_blob(bucket, f"{prefix}/clone_plan.json"),
                "clone_result": _read_json_blob(bucket, f"{prefix}/clone_result.json"),
                "voice_profile_result": _read_json_blob(bucket, f"{prefix}/voice_profile_result.json"),
                "source_audio_url": source_audio["url"],
                "target_audio_url": target_audio["url"],
                "target_cloned_audio_url": target_cloned_audio["url"],
                "source_audio_base64": source_audio["base64"],
                "target_audio_base64": target_audio["base64"],
                "target_cloned_audio_base64": target_cloned_audio["base64"],
                "source_audio_mime_type": source_audio["mime_type"],
                "target_audio_mime_type": target_audio["mime_type"],
                "target_cloned_audio_mime_type": target_cloned_audio["mime_type"],
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
