# FILE: ~/otmega/otmega_app/console/admin_backend/admin_api/apk_release_routes.py
# ماموریت: APK Release Center — رجیستر نسخه‌های APK کولابرا (config_domain_registry:collabra_apk_release)،
# آپلود فایل امضاشده به GCS (مسیر نسخه/تاریخ‌دار زیر main-data) و فعال‌سازی نسخه با یک کلیک.
# ساخت و امضای APK همیشه لوکال می‌ماند؛ این ماژول فقط نگه‌داری نسخه‌ها و انتشار را پوشش می‌دهد.
# درخواست 2082 سند 0016-0201.

import hashlib
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

from flask import Blueprint, jsonify, request
from google.cloud import storage

from admin_api.auth import resolve_actor
from admin_api.guards import require_capability

apk_release_bp = Blueprint("console_apk_release", __name__)

BUCKET_NAME = os.environ.get("APP_DATA_BUCKET_NAME", "otmega-collabra-secure")
# مسیرسازی بر اساس نسخه و تاریخ زیر main-data (تصمیم مالک، درخواست 2082).
APK_RELEASES_BASE_PATH = "advisors/collabra-20018-v1.0.0/main-data/apk-releases"
APK_FILE_NAME_PATTERN = re.compile(r"^ot-collabra-ai-v(?P<version_name>[0-9]+\.[0-9]+\.[0-9]+)-build-(?P<version_code>[0-9]+)\.apk$")
MAX_APK_SIZE_BYTES = 200 * 1024 * 1024  # سقف ایمنی آپلود

_REGISTRY_FILTER = {
    "domain_key": "eq.collabra_apk_release",
    "scope_kind": "eq.advisor",
    "scope_ref": "eq.20018",
}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _rest_headers(write: bool = False) -> dict | None:
    service_role_key = os.environ.get("PRG2_SUPABASE_SERVICE_ROLE_KEY")
    if not service_role_key:
        return None
    headers = {
        "Accept": "application/json",
        "apikey": service_role_key,
        "Authorization": f"Bearer {service_role_key}",
        # UA پیش‌فرض Python-urllib توسط WAF کلادفلر روی db.otmega.com بلاک می‌شود
        "User-Agent": "otmega-console-apk-release/1.0",
    }
    if write:
        headers["Content-Type"] = "application/json"
        headers["Prefer"] = "return=representation"
    return headers


def _fetch_registry_payload() -> tuple[dict, dict]:
    supabase_url = (os.environ.get("PRG2_SUPABASE_URL") or "").rstrip("/")
    headers = _rest_headers()
    if not supabase_url or headers is None:
        raise RuntimeError("PRG2 Supabase env is not configured on console backend.")
    query = urllib.parse.urlencode({"select": "payload,updated_at,version", **_REGISTRY_FILTER}, safe=",().*")
    req = urllib.request.Request(
        f"{supabase_url}/rest/v1/config_domain_registry?{query}",
        headers=headers,
        method="GET",
    )
    with urllib.request.urlopen(req, timeout=10) as response:
        rows = json.loads(response.read().decode("utf-8"))
    row = rows[0] if isinstance(rows, list) and rows and isinstance(rows[0], dict) else None
    if row is None:
        raise RuntimeError(
            "collabra_apk_release row not found in config_domain_registry. "
            "Run docs/80-operational-assets/sql/seed_collabra_apk_release_registry_2026-07-09.sql first."
        )
    payload = row.get("payload") if isinstance(row.get("payload"), dict) else {}
    return payload, {"updated_at": row.get("updated_at"), "version": row.get("version")}


def _patch_registry_payload(new_payload: dict) -> dict:
    supabase_url = (os.environ.get("PRG2_SUPABASE_URL") or "").rstrip("/")
    query = urllib.parse.urlencode(_REGISTRY_FILTER, safe=",().*")
    body = json.dumps({"payload": new_payload, "updated_at": _now_iso()}, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        f"{supabase_url}/rest/v1/config_domain_registry?{query}",
        headers=_rest_headers(write=True),
        data=body,
        method="PATCH",
    )
    with urllib.request.urlopen(req, timeout=20) as response:
        rows = json.loads(response.read().decode("utf-8") or "[]")
    row = rows[0] if isinstance(rows, list) and rows and isinstance(rows[0], dict) else {}
    return row.get("payload") if isinstance(row.get("payload"), dict) else new_payload


def _normalized_releases(payload: dict) -> list[dict]:
    releases = payload.get("releases")
    normalized = [release for release in releases if isinstance(release, dict)] if isinstance(releases, list) else []
    normalized.sort(key=lambda release: int(release.get("version_code") or 0), reverse=True)
    return normalized


def _public_view(payload: dict, meta: dict) -> dict:
    active_release_id = str(payload.get("active_release_id") or "")
    releases = _normalized_releases(payload)
    return {
        "active_release_id": active_release_id,
        "releases": releases,
        "release_count": len(releases),
        "updated_at": meta.get("updated_at"),
        "stable_download_url": "https://api.otmega.com/api/public/collabra-apk/latest",
        "version_info_url": "https://api.otmega.com/api/public/collabra-apk/version",
        "bucket": BUCKET_NAME,
        "base_path": APK_RELEASES_BASE_PATH,
    }


@apk_release_bp.get("/api/console/apk-releases")
@require_capability("console.manage_apk_releases")
def apk_releases_list():
    try:
        payload, meta = _fetch_registry_payload()
        return jsonify({"status": "ok", **_public_view(payload, meta)})
    except Exception as exc:
        return jsonify({"status": "error", "message": f"APK release registry read failed: {type(exc).__name__}: {exc}"}), 502


@apk_release_bp.post("/api/console/apk-releases/upload")
@require_capability("console.manage_apk_releases")
def apk_release_upload():
    actor = resolve_actor(request)
    apk_file = request.files.get("file")
    version_name = str(request.form.get("version_name") or "").strip()
    version_code_raw = str(request.form.get("version_code") or "").strip()
    changelog = str(request.form.get("changelog") or "").strip()
    released_at = str(request.form.get("released_at") or "").strip() or datetime.now(timezone.utc).date().isoformat()

    if apk_file is None or not apk_file.filename:
        return jsonify({"status": "error", "message": "APK file is required (multipart field 'file')."}), 400
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version_name):
        return jsonify({"status": "error", "message": "version_name must look like 1.2.0."}), 400
    if not version_code_raw.isdigit():
        return jsonify({"status": "error", "message": "version_code must be a positive integer."}), 400
    if not changelog:
        return jsonify({"status": "error", "message": "changelog is required."}), 400

    version_code = int(version_code_raw)
    file_name = f"ot-collabra-ai-v{version_name}-build-{version_code}.apk"
    release_id = f"v{version_name}-build-{version_code}"

    file_bytes = apk_file.read()
    if not file_bytes:
        return jsonify({"status": "error", "message": "Uploaded APK file is empty."}), 400
    if len(file_bytes) > MAX_APK_SIZE_BYTES:
        return jsonify({"status": "error", "message": "Uploaded APK exceeds the safety size limit."}), 400
    sha256 = hashlib.sha256(file_bytes).hexdigest()

    try:
        payload, _ = _fetch_registry_payload()
        releases = _normalized_releases(payload)

        existing = next((release for release in releases if str(release.get("release_id")) == release_id), None)
        if existing is not None:
            return jsonify({"status": "error", "message": f"Release {release_id} already exists in the registry."}), 409
        max_existing_code = max((int(release.get("version_code") or 0) for release in releases), default=0)
        if version_code <= max_existing_code:
            return jsonify({
                "status": "error",
                "message": f"version_code must be greater than the highest registered code ({max_existing_code}).",
            }), 400

        gcs_object = f"{APK_RELEASES_BASE_PATH}/{release_id}-{released_at}/{file_name}"
        bucket = storage.Client().bucket(BUCKET_NAME)
        blob = bucket.blob(gcs_object)
        blob.upload_from_string(file_bytes, content_type="application/vnd.android.package-archive")

        new_release = {
            "release_id": release_id,
            "version_name": version_name,
            "version_code": version_code,
            "released_at": released_at,
            "changelog": changelog,
            "file_name": file_name,
            "storage": "gcs",
            "gcs_object": gcs_object,
            "download_url": None,
            "size_bytes": len(file_bytes),
            "sha256": sha256,
            "status": "archived",
            "uploaded_by": actor.email or actor.user_id,
            "created_at": _now_iso(),
        }
        new_payload = dict(payload)
        new_payload["releases"] = [*releases, new_release]
        updated_payload = _patch_registry_payload(new_payload)
        return jsonify({
            "status": "ok",
            "release": new_release,
            **_public_view(updated_payload, {"updated_at": _now_iso()}),
        })
    except Exception as exc:
        return jsonify({"status": "error", "message": f"APK upload failed: {type(exc).__name__}: {exc}"}), 502


@apk_release_bp.post("/api/console/apk-releases/verify")
@require_capability("console.manage_apk_releases")
def apk_release_verify():
    """کنترل زنده انتشار: نسخه عمومی گزارش‌شده و redirect لینک پایدار با نسخه فعال رجیستر مقایسه می‌شود."""
    checks = []
    try:
        payload, _ = _fetch_registry_payload()
        active_release_id = str(payload.get("active_release_id") or "")
        releases = _normalized_releases(payload)
        active = next((release for release in releases if str(release.get("release_id")) == active_release_id), None)
        if active is None:
            return jsonify({"status": "error", "message": "No active release in the registry."}), 400
        checks.append({"name": "registry_active_release", "ok": True, "detail": active_release_id})
    except Exception as exc:
        return jsonify({"status": "error", "message": f"Registry read failed: {type(exc).__name__}: {exc}"}), 502

    public_headers = {
        "Accept": "application/json",
        "User-Agent": "otmega-console-apk-release/1.0",
    }

    try:
        version_request = urllib.request.Request(
            "https://api.otmega.com/api/public/collabra-apk/version",
            headers=public_headers,
            method="GET",
        )
        with urllib.request.urlopen(version_request, timeout=15) as response:
            version_payload = json.loads(response.read().decode("utf-8"))
        reported_code = version_payload.get("version_code")
        expected_code = active.get("version_code")
        matches = str(reported_code) == str(expected_code)
        checks.append({
            "name": "public_version_endpoint",
            "ok": matches,
            "detail": f"reported version_code={reported_code}, expected={expected_code}",
        })
    except Exception as exc:
        checks.append({"name": "public_version_endpoint", "ok": False, "detail": f"{type(exc).__name__}: {exc}"})

    class _NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None

    try:
        opener = urllib.request.build_opener(_NoRedirect)
        latest_request = urllib.request.Request(
            "https://api.otmega.com/api/public/collabra-apk/latest",
            headers=public_headers,
            method="GET",
        )
        location = ""
        try:
            opener.open(latest_request, timeout=15)
            checks.append({"name": "stable_link_redirect", "ok": False, "detail": "Expected a 302 redirect but got a direct response."})
        except urllib.error.HTTPError as http_error:
            location = http_error.headers.get("Location") or ""
            ok = http_error.code in (301, 302, 303, 307, 308) and bool(location)
            checks.append({"name": "stable_link_redirect", "ok": ok, "detail": f"HTTP {http_error.code} -> {location[:200]}"})
    except Exception as exc:
        checks.append({"name": "stable_link_redirect", "ok": False, "detail": f"{type(exc).__name__}: {exc}"})

    all_ok = all(check.get("ok") for check in checks)
    return jsonify({"status": "ok" if all_ok else "warn", "all_ok": all_ok, "checks": checks, "active_release_id": active_release_id})


@apk_release_bp.post("/api/console/apk-releases/activate")
@require_capability("console.manage_apk_releases")
def apk_release_activate():
    actor = resolve_actor(request)
    body = request.get_json(silent=True) or {}
    release_id = str(body.get("release_id") or "").strip()
    if not release_id:
        return jsonify({"status": "error", "message": "release_id is required."}), 400

    try:
        payload, _ = _fetch_registry_payload()
        releases = _normalized_releases(payload)
        target = next((release for release in releases if str(release.get("release_id")) == release_id), None)
        if target is None:
            return jsonify({"status": "error", "message": f"Release {release_id} was not found in the registry."}), 404

        next_releases = []
        for release in releases:
            updated = dict(release)
            updated["status"] = "active" if str(release.get("release_id")) == release_id else "archived"
            next_releases.append(updated)

        new_payload = dict(payload)
        new_payload["releases"] = next_releases
        new_payload["active_release_id"] = release_id
        new_payload["activated_at"] = _now_iso()
        new_payload["activated_by"] = actor.email or actor.user_id
        updated_payload = _patch_registry_payload(new_payload)
        return jsonify({"status": "ok", **_public_view(updated_payload, {"updated_at": _now_iso()})})
    except Exception as exc:
        return jsonify({"status": "error", "message": f"APK release activation failed: {type(exc).__name__}: {exc}"}), 502
