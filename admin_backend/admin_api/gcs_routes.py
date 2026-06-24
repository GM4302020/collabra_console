# FILE: ~/otmega/otmega_app/console/admin_backend/admin_api/gcs_routes.py
# ماموریت: API مرور فایل‌های GCS و تولید signed URL برای پخش/نمایش در کنسول.

import datetime
import json
import logging
import os
import re
import urllib.error as _urlerr
import urllib.parse as _urlparse
import urllib.request as _urlreq

from flask import Blueprint, jsonify, request

from admin_api.guards import require_capability

gcs_bp = Blueprint("console_gcs", __name__)
logger = logging.getLogger(__name__)

BUCKET_NAME = os.environ.get("APP_DATA_BUCKET_NAME", "otmega-collabra-secure")
MAIN_BACKEND_URL = os.environ.get("MAIN_BACKEND_URL", "https://api.otmega.com")
COLLABRA_ADVISOR_ID = int(os.environ.get("COLLABRA_ADVISOR_ID") or os.environ.get("CONSOLE_ADVISOR_ID") or "20018")

AUDIO_EXTENSIONS = frozenset({".wav", ".mp3", ".ogg", ".m4a", ".aac", ".flac"})
IMAGE_EXTENSIONS = frozenset({".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg"})
UUID_RE = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")

MESSAGE_SELECT = (
    "id,conversation_id,sender_id,advisor_id,content_original,src_lang,content_pivot,"
    "text_translations,created_at,status,type,metadata,client_message_id"
)
PARTICIPANT_SELECT = "conversation_id,user_id,joined_at,unread_count"
PROFILE_SELECT = "user_id,advisor_id,email,full_name,last_typed_lang,role,country_code"


def _is_audio(name: str, content_type: str | None) -> bool:
    if content_type and content_type.startswith("audio/"):
        return True
    ext = "." + name.rsplit(".", 1)[-1].lower() if "." in name else ""
    return ext in AUDIO_EXTENSIONS


def _is_image(name: str, content_type: str | None) -> bool:
    if content_type and content_type.startswith("image/"):
        return True
    ext = "." + name.rsplit(".", 1)[-1].lower() if "." in name else ""
    return ext in IMAGE_EXTENSIONS


def _format_size(size: int | None) -> str:
    if size is None:
        return ""
    if size < 1024:
        return f"{size} B"
    if size < 1024 * 1024:
        return f"{size / 1024:.1f} KB"
    return f"{size / (1024 * 1024):.1f} MB"


def _supabase_base_url() -> str:
    base_url = os.environ.get("PRG2_SUPABASE_URL", "").rstrip("/")
    if not base_url.startswith("http"):
        raise RuntimeError("PRG2_SUPABASE_URL is not configured.")
    return f"{base_url}/rest/v1"


def _supabase_headers() -> dict[str, str]:
    key = os.environ.get("PRG2_SUPABASE_SERVICE_ROLE_KEY") or os.environ.get("PRG2_SUPABASE_ANON_KEY")
    if not key:
        raise RuntimeError("Supabase service role key is not configured.")
    return {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Accept": "application/json",
    }


def _supabase_get_rows(table: str, params: dict[str, str], timeout: int = 10) -> list[dict]:
    query = _urlparse.urlencode(params, safe=",().*:->")
    req = _urlreq.Request(
        f"{_supabase_base_url()}/{table}?{query}",
        headers=_supabase_headers(),
        method="GET",
    )
    with _urlreq.urlopen(req, timeout=timeout) as resp:
        payload = json.loads(resp.read().decode("utf-8") or "[]")
    return payload if isinstance(payload, list) else []


def _normalize_blob_path(path: str) -> str:
    return str(path or "").strip().lstrip("/")


def _extract_conversation_id_from_path(path: str) -> str | None:
    match = UUID_RE.search(path or "")
    return match.group(0).lower() if match else None


def _metadata_path_values(metadata: object) -> set[str]:
    if not isinstance(metadata, dict):
        return set()
    values: set[str] = set()
    path_keys = {"file_path", "storage_path", "blob_name", "gcs_path", "original_source_path"}
    for key, value in metadata.items():
        if key in path_keys and isinstance(value, str) and value.strip():
            values.add(_normalize_blob_path(value))
        elif isinstance(value, dict):
            values.update(_metadata_path_values(value))
        elif isinstance(value, list):
            for item in value:
                values.update(_metadata_path_values(item))
    return values


def _message_matches_blob(message: dict, blob_name: str) -> bool:
    paths = _metadata_path_values(message.get("metadata"))
    if blob_name in paths:
        return True
    filename = blob_name.rsplit("/", 1)[-1]
    return bool(filename and any(path.endswith(f"/{filename}") or path == filename for path in paths))


def _find_message_for_blob(blob_name: str) -> tuple[dict | None, str]:
    exact_params = {
        "select": MESSAGE_SELECT,
        "advisor_id": f"eq.{COLLABRA_ADVISOR_ID}",
        "metadata->>file_path": f"eq.{blob_name}",
        "limit": "1",
    }
    try:
        rows = _supabase_get_rows("messages", exact_params)
        if rows:
            return rows[0], "metadata.file_path"
    except Exception as exc:
        logger.warning("[GCS-AUDIO-CONTEXT] exact metadata lookup failed: %s", exc)

    conversation_id = _extract_conversation_id_from_path(blob_name)
    if not conversation_id:
        return None, "no_conversation_id_in_path"

    rows = _supabase_get_rows(
        "messages",
        {
            "select": MESSAGE_SELECT,
            "advisor_id": f"eq.{COLLABRA_ADVISOR_ID}",
            "conversation_id": f"eq.{conversation_id}",
            "order": "created_at.desc",
            "limit": "120",
        },
    )
    for row in rows:
        if _message_matches_blob(row, blob_name):
            return row, "conversation_path_metadata_match"
    return None, "conversation_found_no_message_path_match"


def _profile_map(user_ids: list[str]) -> dict[str, dict]:
    ids = [user_id for user_id in dict.fromkeys(user_ids) if user_id]
    if not ids:
        return {}
    rows = _supabase_get_rows(
        "profiles",
        {
            "select": PROFILE_SELECT,
            "advisor_id": f"eq.{COLLABRA_ADVISOR_ID}",
            "user_id": f"in.({','.join(ids)})",
            "limit": str(max(1, len(ids))),
        },
    )
    return {str(row.get("user_id")): row for row in rows if row.get("user_id")}


def _participants_for_conversation(conversation_id: str) -> list[dict]:
    return _supabase_get_rows(
        "conversation_participants",
        {
            "select": PARTICIPANT_SELECT,
            "conversation_id": f"eq.{conversation_id}",
            "limit": "20",
        },
    )


def _lang_label(code: object) -> str | None:
    if not isinstance(code, str):
        return None
    normalized = code.strip().lower()
    return normalized or None


def _first_metadata_lang(metadata: object, keys: tuple[str, ...]) -> tuple[str | None, str | None]:
    if not isinstance(metadata, dict):
        return None, None
    for key in keys:
        value = _lang_label(metadata.get(key))
        if value:
            return value, f"metadata.{key}"
    language_context = metadata.get("language_context")
    if isinstance(language_context, dict):
        for key in keys:
            value = _lang_label(language_context.get(key))
            if value:
                return value, f"metadata.language_context.{key}"
    return None, None


def _translation_langs(message: dict) -> list[str]:
    translations = message.get("text_translations")
    if not isinstance(translations, dict):
        return []
    return [_lang_label(key) for key in translations.keys() if _lang_label(key)]


def _user_payload(user_id: str, profile: dict | None, language: str | None, language_source: str | None) -> dict:
    profile = profile or {}
    return {
        "user_id": user_id,
        "email": profile.get("email"),
        "full_name": profile.get("full_name"),
        "role": profile.get("role"),
        "country_code": profile.get("country_code"),
        "language": language,
        "language_source": language_source,
        "current_profile_language": _lang_label(profile.get("last_typed_lang")),
    }


def _build_audio_context(blob_name: str) -> dict:
    message, match_strategy = _find_message_for_blob(blob_name)
    if not message:
        return {
            "status": "not_found",
            "blob_name": blob_name,
            "bucket": BUCKET_NAME,
            "match_strategy": match_strategy,
            "message": "No Collabra message record matched this audio file path.",
        }

    metadata = message.get("metadata") if isinstance(message.get("metadata"), dict) else {}
    conversation_id = str(message.get("conversation_id") or "")
    sender_id = str(message.get("sender_id") or "")
    participants = _participants_for_conversation(conversation_id) if conversation_id else []
    participant_ids = [str(row.get("user_id") or "") for row in participants if row.get("user_id")]
    if sender_id and sender_id not in participant_ids:
        participant_ids.append(sender_id)
    profiles = _profile_map(participant_ids)

    source_lang = _lang_label(message.get("src_lang"))
    source_lang_source = "messages.src_lang" if source_lang else None
    if not source_lang:
        source_lang, source_lang_source = _first_metadata_lang(metadata, ("src_lang", "source_lang", "detected_src_lang"))
    if not source_lang:
        sender_profile = profiles.get(sender_id)
        source_lang = _lang_label(sender_profile.get("last_typed_lang") if sender_profile else None)
        source_lang_source = "profiles.last_typed_lang_current" if source_lang else None

    metadata_destination_lang, metadata_destination_source = _first_metadata_lang(
        metadata,
        ("receiver_lang", "guest_receiver_lang", "dst_lang", "target_lang", "destination_lang"),
    )
    translation_langs = _translation_langs(message)

    sender = _user_payload(sender_id, profiles.get(sender_id), source_lang, source_lang_source)
    recipient_ids = [user_id for user_id in participant_ids if user_id and user_id != sender_id]
    recipients = []
    for index, user_id in enumerate(recipient_ids):
        profile = profiles.get(user_id, {})
        lang = None
        lang_source = None
        if metadata_destination_lang:
            lang = metadata_destination_lang
            lang_source = metadata_destination_source
        elif index < len(translation_langs):
            lang = translation_langs[index]
            lang_source = "messages.text_translations.keys"
        else:
            lang = _lang_label(profile.get("last_typed_lang"))
            lang_source = "profiles.last_typed_lang_current" if lang else None
        recipients.append(_user_payload(user_id, profile, lang, lang_source))

    return {
        "status": "ok",
        "bucket": BUCKET_NAME,
        "blob_name": blob_name,
        "match_strategy": match_strategy,
        "conversation": {
            "id": conversation_id,
            "participant_count": len(participant_ids),
        },
        "message_record": {
            "id": message.get("id"),
            "created_at": message.get("created_at"),
            "type": message.get("type"),
            "status": message.get("status"),
            "client_message_id": message.get("client_message_id"),
            "metadata_paths": sorted(_metadata_path_values(metadata)),
        },
        "sender": sender,
        "recipients": recipients,
        "participants": [
            _user_payload(
                user_id,
                profiles.get(user_id),
                sender["language"] if user_id == sender_id else next((r["language"] for r in recipients if r["user_id"] == user_id), None),
                sender["language_source"] if user_id == sender_id else next((r["language_source"] for r in recipients if r["user_id"] == user_id), None),
            )
            for user_id in participant_ids
        ],
        "language_summary": {
            "source_language": source_lang,
            "source_language_source": source_lang_source,
            "destination_languages": [
                {"user_id": row["user_id"], "language": row["language"], "source": row["language_source"]}
                for row in recipients
            ],
            "historical_destination_available": any(
                (row.get("language_source") or "").startswith("metadata.")
                or row.get("language_source") == "messages.text_translations.keys"
                for row in recipients
            ),
        },
    }


@gcs_bp.get("/api/console/gcs/browse")
@require_capability("console.view_gcs_browser")
def gcs_browse():
    prefix = request.args.get("prefix", "")
    page_token = request.args.get("page_token") or None
    try:
        max_results = min(500, max(1, int(request.args.get("max_results", "200"))))
    except (ValueError, TypeError):
        max_results = 200

    try:
        from google.cloud import storage

        client = storage.Client()
        bucket = client.bucket(BUCKET_NAME)
        blobs_iterator = bucket.list_blobs(
            prefix=prefix or None,
            delimiter="/",
            max_results=max_results,
            page_token=page_token,
        )
        page = next(blobs_iterator.pages)

        folders = sorted(blobs_iterator.prefixes)
        files = []
        for blob in page:
            if blob.name == prefix:
                continue
            content_type = blob.content_type or ""
            audio = _is_audio(blob.name, content_type)
            image = _is_image(blob.name, content_type)
            short_name = blob.name[len(prefix):] if prefix and blob.name.startswith(prefix) else blob.name
            files.append({
                "name": blob.name,
                "short_name": short_name,
                "size": blob.size,
                "size_label": _format_size(blob.size),
                "content_type": content_type,
                "updated": blob.updated.isoformat() if blob.updated else None,
                "is_audio": audio,
                "is_image": image,
            })

        next_page_token = blobs_iterator.next_page_token

    except ImportError:
        return jsonify({"status": "error", "message": "google-cloud-storage is not installed."}), 500
    except Exception as exc:
        return jsonify({"status": "error", "message": f"GCS browse failed: {type(exc).__name__}: {exc}"}), 502

    return jsonify({
        "status": "ok",
        "bucket": BUCKET_NAME,
        "prefix": prefix,
        "folders": [
            {
                "prefix": folder,
                "short_name": folder[len(prefix):].rstrip("/") if prefix and folder.startswith(prefix) else folder.rstrip("/"),
            }
            for folder in folders
        ],
        "files": files,
        "next_page_token": next_page_token,
    })


@gcs_bp.post("/api/console/gcs/signed-url")
@require_capability("console.view_gcs_browser")
def gcs_signed_url():
    payload = request.get_json(silent=True) or {}
    path = str(payload.get("path") or "").strip().lstrip("/")
    if not path:
        return jsonify({"status": "error", "message": "path is required."}), 400

    try:
        from google.cloud import storage

        client = storage.Client()
        bucket = client.bucket(BUCKET_NAME)
        blob = bucket.blob(path)
        signed_url = blob.generate_signed_url(
            version="v4",
            expiration=datetime.timedelta(hours=1),
            method="GET",
        )
        signed_url = signed_url.replace("storage.googleapis.com", "files.otmega.com")
    except ImportError:
        return jsonify({"status": "error", "message": "google-cloud-storage is not installed."}), 500
    except Exception as exc:
        return jsonify({"status": "error", "message": f"Signed URL generation failed: {type(exc).__name__}: {exc}"}), 502

    return jsonify({
        "status": "ok",
        "path": path,
        "bucket": BUCKET_NAME,
        "signed_url": signed_url,
    })


@gcs_bp.post("/api/console/gcs/audio-context")
@require_capability("console.use_transcript_api")
def gcs_audio_context():
    payload = request.get_json(silent=True) or {}
    blob_name = _normalize_blob_path(payload.get("blob_name") or payload.get("path") or "")
    if not blob_name:
        return jsonify({"status": "error", "message": "blob_name is required."}), 400

    try:
        context = _build_audio_context(blob_name)
        return jsonify(context), 200
    except _urlerr.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        logger.error("[GCS-AUDIO-CONTEXT] Supabase HTTP %s: %s", exc.code, body[:400])
        return jsonify({"status": "error", "message": f"Supabase lookup failed: [{exc.code}] {body[:240]}"}), 502
    except Exception as exc:
        logger.error("[GCS-AUDIO-CONTEXT] lookup failed: %s", exc)
        return jsonify({"status": "error", "message": f"Audio context lookup failed: {exc}"}), 502


@gcs_bp.post("/api/console/gcs/upload-audio")
@require_capability("console.use_transcript_api")
def upload_audio():
    """آپلود مستقیم بلاب صوتی به GCS زیر مسیر uploads کاربر."""
    import re
    if 'audio' not in request.files:
        return jsonify({"status": "error", "message": "audio field required"}), 400

    audio_file = request.files['audio']
    filename = (request.form.get('filename') or '').strip()
    uploads_prefix = (request.form.get('prefix') or 'users/9197bacb-2387-4639-814f-9d643bbfb245/uploads').strip().strip('/')

    if not filename or not re.match(r'^[\w\-\.]+$', filename):
        import datetime as _dt
        ts = _dt.datetime.utcnow().strftime('%Y%m%d_%H%M%S')
        mime_ext = {
            'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/wav': 'wav',
            'audio/mp3': 'mp3', 'audio/mpeg': 'mp3', 'audio/m4a': 'm4a',
        }
        ext = mime_ext.get(audio_file.content_type or '', 'webm')
        filename = f"rec_{ts}.{ext}"

    blob_path = f"{uploads_prefix}/{filename}"

    try:
        from google.cloud import storage as _gcs
        client = _gcs.Client()
        bucket = client.bucket(BUCKET_NAME)
        blob = bucket.blob(blob_path)
        blob.upload_from_file(audio_file.stream, content_type=audio_file.content_type or 'audio/webm')
        logger.info("[GCS-UPLOAD] saved: %s", blob_path)
        return jsonify({"status": "ok", "path": blob_path, "filename": filename, "bucket": BUCKET_NAME}), 200
    except Exception as exc:
        logger.error("upload_audio error: %s", exc)
        return jsonify({"status": "error", "message": str(exc)}), 500


@gcs_bp.post("/api/console/gcs/transcribe")
@require_capability("console.use_transcript_api")
def gcs_transcribe():
    payload = request.get_json(silent=True) or {}
    blob_name = str(payload.get("blob_name") or "").strip().lstrip("/")
    mime_type = str(payload.get("mime_type") or "audio/mp3").strip()
    model_key = str(payload.get("model_key") or "gemini-2.5-flash").strip()
    if not blob_name:
        return jsonify({"status": "error", "message": "blob_name is required."}), 400

    logger.info("[SVLIP] transcribe request: blob=%s mime=%s model=%s", blob_name, mime_type, model_key)
    req_body = json.dumps({
        "bucket_name": BUCKET_NAME,
        "blob_name": blob_name,
        "mime_type": mime_type,
        "model_key": model_key,
    }).encode("utf-8")
    req = _urlreq.Request(
        f"{MAIN_BACKEND_URL}/api/audio/transcribe-phonetic",
        data=req_body,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    try:
        with _urlreq.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        lang = data.get("data", {}).get("detected_language", "?")
        ipa = data.get("data", {}).get("phonetic_ipa")
        logger.info("[SVLIP] backend response: model=%s lang=%s ipa_ok=%s", model_key, lang, bool(ipa))
        return jsonify(data), 200
    except _urlerr.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        logger.error("[SVLIP:P1] main backend HTTP %s: %s", exc.code, body[:400])
        return jsonify({"status": "error", "message": f"[{exc.code}] {body[:400]}"}), 502
    except Exception as exc:
        logger.error("[SVLIP:P1] proxy error: %s", exc)
        return jsonify({"status": "error", "message": f"Proxy error: {exc}"}), 502


@gcs_bp.post("/api/console/gcs/lip-translate")
@require_capability("console.use_transcript_api")
def gcs_lip_translate():
    payload = request.get_json(silent=True) or {}
    transcript = str(payload.get("transcript") or "").strip()
    source_lang = str(payload.get("source_lang") or "en").strip().lower()
    target_lang = str(payload.get("target_lang") or "").strip().lower()
    model_key = str(payload.get("model_key") or "wf1-runtime").strip()
    if not transcript:
        return jsonify({"status": "error", "message": "transcript is required."}), 400
    if not target_lang:
        return jsonify({"status": "error", "message": "target_lang is required."}), 400

    req_body = json.dumps({
        "transcript": transcript,
        "source_lang": source_lang,
        "target_lang": target_lang,
        "model_key": model_key,
    }).encode("utf-8")
    req = _urlreq.Request(
        f"{MAIN_BACKEND_URL}/api/audio/lip-translate",
        data=req_body,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    try:
        with _urlreq.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        return jsonify(data), 200
    except _urlerr.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        logger.error("[SVLIP-LIP] main backend HTTP %s: %s", exc.code, body[:400])
        return jsonify({"status": "error", "message": f"[{exc.code}] {body[:400]}"}), 502
    except Exception as exc:
        logger.error("[SVLIP-LIP] proxy error: %s", exc)
        return jsonify({"status": "error", "message": f"Proxy error: {exc}"}), 502
