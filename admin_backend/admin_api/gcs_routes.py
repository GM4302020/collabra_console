# FILE: ~/otmega/otmega_app/console/admin_backend/admin_api/gcs_routes.py
# ماموریت: API مرور فایل‌های GCS و تولید signed URL برای پخش/نمایش در کنسول.

import datetime
import os

from flask import Blueprint, jsonify, request

from admin_api.guards import require_capability

gcs_bp = Blueprint("console_gcs", __name__)

BUCKET_NAME = os.environ.get("APP_DATA_BUCKET_NAME", "otmega-collabra-secure")

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
