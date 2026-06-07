# FILE: ~/otmega/otmega_app/console/admin_backend/admin_api/gcs_routes.py
# ماموریت: API مرور فایل‌های GCS و تولید signed URL برای پخش/نمایش در کنسول.

import datetime
import json
import logging
import os
import urllib.error as _urlerr
import urllib.request as _urlreq

from flask import Blueprint, jsonify, request

from admin_api.guards import require_capability

gcs_bp = Blueprint("console_gcs", __name__)
logger = logging.getLogger(__name__)

BUCKET_NAME = os.environ.get("APP_DATA_BUCKET_NAME", "otmega-collabra-secure")
MAIN_BACKEND_URL = os.environ.get("MAIN_BACKEND_URL", "https://api.otmega.com")

AUDIO_EXTENSIONS = frozenset({".wav", ".mp3", ".ogg", ".m4a", ".aac", ".flac"})
IMAGE_EXTENSIONS = frozenset({".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg"})


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
