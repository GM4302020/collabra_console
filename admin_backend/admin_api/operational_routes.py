# FILE: ~/otmega/otmega_app/console/admin_backend/admin_api/operational_routes.py
# ماموریت: ارائه inventory و probe زنده زیرساخت های Collabra برای داشبورد Admin Console.

import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

from flask import Blueprint, current_app, jsonify, request

from admin_api.guards import require_capability

operational_bp = Blueprint("console_operational", __name__)


PROJECT_ID = os.environ.get("GOOGLE_CLOUD_PROJECT") or os.environ.get("GCP_PROJECT") or "ot-ai-advisor"
REGION = os.environ.get("CONSOLE_CLOUD_RUN_REGION") or os.environ.get("GOOGLE_CLOUD_REGION") or "us-central1"
ADVISOR_ID = os.environ.get("CONSOLE_ADVISOR_ID", "20018")
FIREBASE_HOSTING_SITE_ID = os.environ.get("FIREBASE_HOSTING_SITE_ID") or "ot-ai-advisor"
FIREBASE_HOSTING_PRIMARY_URL = os.environ.get("FIREBASE_HOSTING_PRIMARY_URL") or "https://app.otmega.com"
CONSOLE_CLOUD_RUN_SERVICE = os.environ.get("CONSOLE_CLOUD_RUN_SERVICE") or "otmega-console"
RECOMMENDED_TRANSCRIPT_TIMEOUT_SECONDS = 150
DIGEST_PATTERN = re.compile(r"(sha256:[0-9a-f]{16,64})", re.IGNORECASE)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _elapsed_ms(start: float) -> int:
    return int((time.perf_counter() - start) * 1000)


def _metric(label: str, value: str, state: str = "neutral") -> dict:
    return {"label": label, "value": value, "state": state}


def _link(label: str, url: str | None) -> dict | None:
    if not url:
        return None
    return {"label": label, "url": url}


def _resource(
    *,
    resource_id: str,
    group: str,
    name: str,
    kind: str,
    status: str,
    summary: str,
    primary_url: str | None = None,
    console_url: str | None = None,
    latency_ms: int | None = None,
    metrics: list[dict] | None = None,
    links: list[dict | None] | None = None,
) -> dict:
    compact_links = [item for item in (links or []) if item]
    if primary_url:
        compact_links.insert(0, {"label": "Open", "url": primary_url})
    if console_url:
        compact_links.append({"label": "Console", "url": console_url})
    return {
        "id": resource_id,
        "group": group,
        "name": name,
        "kind": kind,
        "status": status,
        "summary": summary,
        "primary_url": primary_url,
        "console_url": console_url,
        "latency_ms": latency_ms,
        "metrics": metrics or [],
        "links": compact_links,
        "checked_at": _now_iso(),
    }


def _cloudflare_config() -> dict:
    return {
        "api_token": os.environ.get("CLOUDFLARE_API_TOKEN"),
        "account_id": os.environ.get("CLOUDFLARE_ACCOUNT_ID"),
        "zone_id": os.environ.get("CLOUDFLARE_ZONE_ID"),
        "zone_name": os.environ.get("CLOUDFLARE_ZONE_NAME") or "otmega.com",
    }


def _cloudflare_headers(api_token: str) -> dict:
    return {
        "Accept": "application/json",
        "Authorization": f"Bearer {api_token}",
        "User-Agent": "otmega-admin-console/1.0",
    }


def _read_cloudflare_api(path: str, api_token: str, *, timeout: int = 8) -> tuple[dict, int, int]:
    url = f"https://api.cloudflare.com/client/v4/{path.lstrip('/')}"
    start = time.perf_counter()
    probe_request = urllib.request.Request(url, headers=_cloudflare_headers(api_token), method="GET")
    with urllib.request.urlopen(probe_request, timeout=timeout) as response:
        payload = response.read().decode("utf-8")
        decoded = json.loads(payload or "{}")
        if not isinstance(decoded, dict):
            decoded = {}
        return decoded, response.status, _elapsed_ms(start)


def _cloudflare_total(payload: dict, fallback_len: int = 0) -> int:
    result_info = payload.get("result_info")
    if isinstance(result_info, dict) and isinstance(result_info.get("total_count"), int):
        return int(result_info["total_count"])
    result = payload.get("result")
    return len(result) if isinstance(result, list) else fallback_len


def _cloudflare_result_list(payload: dict) -> list[dict]:
    result = payload.get("result")
    return [item for item in result if isinstance(item, dict)] if isinstance(result, list) else []


def _host_present(records: list[dict], host: str) -> bool:
    return any((record.get("name") or "").lower() == host.lower() for record in records)


def _route_present(routes: list[dict], host: str) -> bool:
    host = host.lower()
    for route in routes:
        pattern = (route.get("pattern") or "").lower()
        if pattern == host or pattern.startswith(f"{host}/") or pattern.startswith(f"{host}/*"):
            return True
    return False


def _cloudflare_api_error_summary(exc: urllib.error.HTTPError, label: str) -> str:
    if exc.code in {401, 403}:
        return f"{label} returned HTTP {exc.code}; Cloudflare token needs the matching read permission."
    if exc.code == 404:
        return f"{label} returned HTTP 404; Cloudflare account/zone identifiers should be checked."
    return f"{label} returned HTTP {exc.code}."


def _google_access_token(scopes: list[str]) -> str:
    if os.environ.get("K_SERVICE"):
        metadata_url = (
            "http://metadata.google.internal/computeMetadata/v1/instance/"
            "service-accounts/default/token"
        )
        request_headers = {"Metadata-Flavor": "Google"}
        probe_request = urllib.request.Request(metadata_url, headers=request_headers, method="GET")
        with urllib.request.urlopen(probe_request, timeout=5) as response:
            payload = json.loads(response.read().decode("utf-8") or "{}")
            token = payload.get("access_token")
            if token:
                return token
        raise RuntimeError("metadata_access_token_unavailable")

    import google.auth
    from google.auth.transport.requests import Request as GoogleAuthRequest

    credentials, _ = google.auth.default(scopes=scopes)
    credentials.refresh(GoogleAuthRequest())
    return credentials.token


def _google_api_headers(access_token: str) -> dict:
    return {
        "Accept": "application/json",
        "Authorization": f"Bearer {access_token}",
        "User-Agent": "otmega-admin-console/1.0",
        "x-goog-user-project": PROJECT_ID,
    }


def _read_google_api(url: str, access_token: str, *, timeout: int = 8) -> tuple[dict, int, int]:
    start = time.perf_counter()
    probe_request = urllib.request.Request(url, headers=_google_api_headers(access_token), method="GET")
    with urllib.request.urlopen(probe_request, timeout=timeout) as response:
        payload = response.read().decode("utf-8")
        decoded = json.loads(payload or "{}")
        if not isinstance(decoded, dict):
            decoded = {}
        return decoded, response.status, _elapsed_ms(start)


def _post_google_api(url: str, access_token: str, body: dict, *, timeout: int = 8) -> tuple[dict, int, int]:
    start = time.perf_counter()
    payload = json.dumps(body).encode("utf-8")
    headers = {**_google_api_headers(access_token), "Content-Type": "application/json"}
    probe_request = urllib.request.Request(url, data=payload, headers=headers, method="POST")
    with urllib.request.urlopen(probe_request, timeout=timeout) as response:
        decoded_payload = response.read().decode("utf-8")
        decoded = json.loads(decoded_payload or "{}")
        if not isinstance(decoded, dict):
            decoded = {}
        return decoded, response.status, _elapsed_ms(start)


def _firebase_console_url(site_id: str | None = None) -> str:
    if site_id:
        return f"https://console.firebase.google.com/project/{PROJECT_ID}/hosting/sites/{site_id}"
    return f"https://console.firebase.google.com/project/{PROJECT_ID}/hosting/sites"


def _check_firebase_hosting() -> dict:
    site_id = FIREBASE_HOSTING_SITE_ID
    primary_url = FIREBASE_HOSTING_PRIMARY_URL
    console_url = _firebase_console_url(site_id)
    api_root = f"https://firebasehosting.googleapis.com/v1beta1/projects/{PROJECT_ID}/sites/{site_id}"
    start = time.perf_counter()
    public_status = "not checked"
    release_status = "not checked"
    release_type = "unknown"
    release_time = "unknown"
    version_id = "unknown"
    file_count = "unknown"
    version_bytes = "unknown"

    try:
        token = _google_access_token(["https://www.googleapis.com/auth/firebase.readonly"])
    except Exception as exc:
        return _resource(
            resource_id="firebase-hosting",
            group="Frontend",
            name="Collabra Firebase Hosting",
            kind="Firebase Hosting",
            status="unknown",
            summary=f"Firebase Hosting API credential is not available: {type(exc).__name__}.",
            primary_url=primary_url,
            console_url=console_url,
            latency_ms=_elapsed_ms(start),
            metrics=[
                _metric("site", site_id),
                _metric("integration", "not integrated", "unknown"),
            ],
        )

    status = "unknown"
    summary = "Firebase Hosting release probe was not checked."
    api_latency = 0
    try:
        releases_payload, http_status, api_latency = _read_google_api(f"{api_root}/releases?pageSize=1", token)
        releases = releases_payload.get("releases") if isinstance(releases_payload.get("releases"), list) else []
        latest = releases[0] if releases else {}
        version = latest.get("version") if isinstance(latest.get("version"), dict) else {}
        release_status = str(http_status)
        release_type = latest.get("type") or "unknown"
        release_time = latest.get("releaseTime") or "unknown"
        version_name = version.get("name") or ""
        version_id = version_name.rsplit("/", 1)[-1] if version_name else "unknown"
        version_status = version.get("status") or "unknown"
        file_count = str(version.get("fileCount") or "unknown")
        version_bytes = str(version.get("versionBytes") or "unknown")
        if http_status == 200 and releases and version_status == "FINALIZED":
            status = "ok"
            summary = "Firebase Hosting latest release is reachable and finalized."
        elif http_status == 200 and releases:
            status = "warn"
            summary = f"Firebase Hosting latest release is reachable with version status {version_status}."
        else:
            status = "warn"
            summary = "Firebase Hosting API is reachable, but no release was returned."
    except urllib.error.HTTPError as exc:
        release_status = str(exc.code)
        if exc.code in {401, 403}:
            status = "warn"
            summary = f"Firebase Hosting API returned HTTP {exc.code}; service account needs Firebase Hosting Viewer."
        elif exc.code == 404:
            status = "error"
            summary = "Firebase Hosting site was not found; site id should be checked."
        else:
            status = "error"
            summary = f"Firebase Hosting API returned HTTP {exc.code}."
    except Exception as exc:
        status = "error"
        summary = f"Firebase Hosting API probe failed: {type(exc).__name__}."

    public_latency = 0
    try:
        probe_request = urllib.request.Request(primary_url, headers={"User-Agent": "otmega-admin-console/1.0"}, method="GET")
        public_start = time.perf_counter()
        with urllib.request.urlopen(probe_request, timeout=6) as response:
            public_latency = _elapsed_ms(public_start)
            public_status = str(response.status)
            if response.status >= 500 and status == "ok":
                status = "warn"
                summary = f"Firebase Hosting release is finalized, but public endpoint returned HTTP {response.status}."
    except urllib.error.HTTPError as exc:
        public_status = str(exc.code)
        if exc.code >= 500 and status == "ok":
            status = "warn"
            summary = f"Firebase Hosting release is finalized, but public endpoint returned HTTP {exc.code}."
    except Exception:
        public_status = "failed"
        if status == "ok":
            status = "warn"
            summary = "Firebase Hosting release is finalized, but public endpoint probe failed."

    return _resource(
        resource_id="firebase-hosting",
        group="Frontend",
        name="Collabra Firebase Hosting",
        kind="Firebase Hosting",
        status=status,
        summary=summary,
        primary_url=primary_url,
        console_url=console_url,
        latency_ms=api_latency + public_latency or _elapsed_ms(start),
        metrics=[
            _metric("site", site_id, "ok"),
            _metric("release HTTP", release_status, "ok" if release_status == "200" else status),
            _metric("public HTTP", public_status, "ok" if public_status.startswith("2") else status),
            _metric("release type", release_type, "neutral"),
            _metric("release time", release_time, "neutral"),
            _metric("version", version_id, "neutral"),
            _metric("files", file_count, "neutral"),
            _metric("bytes", version_bytes, "neutral"),
        ],
        links=[
            _link("Hosting releases", console_url),
            _link("Firebase API", api_root),
        ],
    )


def _firebase_release_item(release: dict) -> dict:
    version = release.get("version") if isinstance(release.get("version"), dict) else {}
    version_name = version.get("name") or ""
    return {
        "name": release.get("name") or "",
        "type": release.get("type") or "unknown",
        "release_time": release.get("releaseTime") or None,
        "release_user_email": (release.get("releaseUser") or {}).get("email") if isinstance(release.get("releaseUser"), dict) else None,
        "version": version_name.rsplit("/", 1)[-1] if version_name else "unknown",
        "version_status": version.get("status") or "unknown",
        "file_count": str(version.get("fileCount") or "unknown"),
        "version_bytes": str(version.get("versionBytes") or "unknown"),
        "create_time": version.get("createTime") or None,
        "finalize_time": version.get("finalizeTime") or None,
        "deployment_tool": (version.get("labels") or {}).get("deployment-tool") if isinstance(version.get("labels"), dict) else None,
    }


def _read_firebase_hosting_releases(page_size: int = 10) -> tuple[list[dict], int, int]:
    bounded_page_size = max(1, min(page_size, 25))
    token = _google_access_token(["https://www.googleapis.com/auth/firebase.readonly"])
    api_url = (
        "https://firebasehosting.googleapis.com/v1beta1/"
        f"projects/{PROJECT_ID}/sites/{FIREBASE_HOSTING_SITE_ID}/releases?pageSize={bounded_page_size}"
    )
    payload, http_status, latency_ms = _read_google_api(api_url, token)
    raw_releases = payload.get("releases") if isinstance(payload.get("releases"), list) else []
    return [_firebase_release_item(release) for release in raw_releases if isinstance(release, dict)], http_status, latency_ms


def _bounded_int(value: str | None, default: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value or str(default))
    except ValueError:
        parsed = default
    return max(minimum, min(parsed, maximum))


def _redact_log_text(value: str) -> str:
    redacted = value
    sensitive_markers = ["authorization", "bearer ", "cookie", "set-cookie", "token", "secret", "api_key", "apikey", "password"]
    for marker in sensitive_markers:
        lower = redacted.lower()
        index = lower.find(marker)
        while index >= 0:
            line_start = redacted.rfind("\n", 0, index) + 1
            line_end = redacted.find("\n", index)
            if line_end == -1:
                line_end = len(redacted)
            redacted = f"{redacted[:line_start]}[redacted sensitive log line]{redacted[line_end:]}"
            lower = redacted.lower()
            index = lower.find(marker, line_start + 29)
    return redacted[:1200]


def _stringify_log_payload(entry: dict) -> str:
    if isinstance(entry.get("textPayload"), str):
        return _redact_log_text(entry["textPayload"])
    if isinstance(entry.get("jsonPayload"), dict):
        safe_payload = {}
        for key, value in entry["jsonPayload"].items():
            if any(marker in str(key).lower() for marker in ("authorization", "cookie", "token", "secret", "password", "api_key", "apikey")):
                safe_payload[key] = "[redacted]"
            else:
                safe_payload[key] = value
        return _redact_log_text(json.dumps(safe_payload, ensure_ascii=False, sort_keys=True)[:1200])
    if isinstance(entry.get("protoPayload"), dict):
        proto = entry["protoPayload"]
        method = proto.get("methodName") or "unknown_method"
        service = proto.get("serviceName") or "unknown_service"
        status = proto.get("status") if isinstance(proto.get("status"), dict) else {}
        return _redact_log_text(json.dumps({"service": service, "method": method, "status": status}, ensure_ascii=False, sort_keys=True))
    return ""


def _cloud_run_log_item(entry: dict) -> dict:
    resource_labels = (entry.get("resource") or {}).get("labels")
    labels = resource_labels if isinstance(resource_labels, dict) else {}
    http_request = entry.get("httpRequest") if isinstance(entry.get("httpRequest"), dict) else {}
    return {
        "timestamp": entry.get("timestamp") or entry.get("receiveTimestamp") or None,
        "receive_timestamp": entry.get("receiveTimestamp") or None,
        "severity": entry.get("severity") or "DEFAULT",
        "message": _stringify_log_payload(entry),
        "log_name": entry.get("logName") or "",
        "insert_id": entry.get("insertId") or "",
        "revision": labels.get("revision_name") or "unknown",
        "service": labels.get("service_name") or CONSOLE_CLOUD_RUN_SERVICE,
        "location": labels.get("location") or REGION,
        "http_method": http_request.get("requestMethod") or None,
        "request_url": http_request.get("requestUrl") or None,
        "status": http_request.get("status") or None,
        "latency": http_request.get("latency") or None,
    }


def _cloud_build_log_item(entry: dict) -> dict:
    resource_labels = (entry.get("resource") or {}).get("labels")
    labels = resource_labels if isinstance(resource_labels, dict) else {}
    message = _stringify_log_payload(entry)
    upper_message = message.strip().upper()
    digest_match = DIGEST_PATTERN.search(message)
    event = "log"
    build_status = "unknown"
    artifact_digest = digest_match.group(1) if digest_match else None
    if "CLOUDBUILD.CREATEBUILD" in upper_message or "CLOUDBUILD.CREATEBUILD" in upper_message.replace(" ", ""):
        event = "create_build"
    elif upper_message == "DONE" or upper_message.endswith("\nDONE"):
        event = "done"
        build_status = "done"
    elif digest_match:
        event = "artifact_digest"
        build_status = "pushed"
    elif "ERROR" in upper_message or "FAIL" in upper_message:
        event = "failure"
        build_status = "failed"
    return {
        "timestamp": entry.get("timestamp") or entry.get("receiveTimestamp") or None,
        "receive_timestamp": entry.get("receiveTimestamp") or None,
        "severity": entry.get("severity") or "DEFAULT",
        "message": message,
        "log_name": entry.get("logName") or "",
        "insert_id": entry.get("insertId") or "",
        "revision": labels.get("build_id") or labels.get("build_trigger_id") or "unknown",
        "service": "cloud-build",
        "location": labels.get("build_region") or labels.get("location") or REGION,
        "http_method": None,
        "request_url": None,
        "status": None,
        "latency": None,
        "event": event,
        "build_status": build_status,
        "artifact_digest": artifact_digest,
    }


def _read_cloud_run_logs(*, hours: int = 1, severity: str = "DEFAULT", limit: int = 50) -> tuple[list[dict], int, int]:
    bounded_hours = max(1, min(hours, 24))
    bounded_limit = max(1, min(limit, 100))
    allowed_severities = {"DEFAULT", "DEBUG", "INFO", "NOTICE", "WARNING", "ERROR", "CRITICAL", "ALERT", "EMERGENCY"}
    severity_filter = severity.upper() if severity.upper() in allowed_severities else "DEFAULT"
    since = datetime.now(timezone.utc) - timedelta(hours=bounded_hours)
    filter_parts = [
        'resource.type="cloud_run_revision"',
        f'resource.labels.service_name="{CONSOLE_CLOUD_RUN_SERVICE}"',
        f'resource.labels.location="{REGION}"',
        f'timestamp>="{since.isoformat().replace("+00:00", "Z")}"',
    ]
    if severity_filter != "DEFAULT":
        filter_parts.append(f"severity>={severity_filter}")

    token = _google_access_token(["https://www.googleapis.com/auth/logging.read"])
    payload, http_status, latency_ms = _post_google_api(
        "https://logging.googleapis.com/v2/entries:list",
        token,
        {
            "resourceNames": [f"projects/{PROJECT_ID}"],
            "filter": " AND ".join(filter_parts),
            "orderBy": "timestamp desc",
            "pageSize": bounded_limit,
        },
        timeout=10,
    )
    entries = payload.get("entries") if isinstance(payload.get("entries"), list) else []
    return [_cloud_run_log_item(entry) for entry in entries if isinstance(entry, dict)], http_status, latency_ms


def _read_cloud_build_logs(*, hours: int = 24, severity: str = "DEFAULT", limit: int = 50) -> tuple[list[dict], int, int]:
    bounded_hours = max(1, min(hours, 24))
    bounded_limit = max(1, min(limit, 100))
    allowed_severities = {"DEFAULT", "DEBUG", "INFO", "NOTICE", "WARNING", "ERROR", "CRITICAL", "ALERT", "EMERGENCY"}
    severity_filter = severity.upper() if severity.upper() in allowed_severities else "DEFAULT"
    since = datetime.now(timezone.utc) - timedelta(hours=bounded_hours)
    filter_parts = [
        'resource.type="build"',
        f'timestamp>="{since.isoformat().replace("+00:00", "Z")}"',
    ]
    if severity_filter != "DEFAULT":
        filter_parts.append(f"severity>={severity_filter}")

    token = _google_access_token(["https://www.googleapis.com/auth/logging.read"])
    payload, http_status, latency_ms = _post_google_api(
        "https://logging.googleapis.com/v2/entries:list",
        token,
        {
            "resourceNames": [f"projects/{PROJECT_ID}"],
            "filter": " AND ".join(filter_parts),
            "orderBy": "timestamp desc",
            "pageSize": bounded_limit,
        },
        timeout=10,
    )
    entries = payload.get("entries") if isinstance(payload.get("entries"), list) else []
    return [_cloud_build_log_item(entry) for entry in entries if isinstance(entry, dict)], http_status, latency_ms


def _check_cloudflare_workers() -> dict:
    config = _cloudflare_config()
    api_token = config["api_token"]
    account_id = config["account_id"]
    zone_id = config["zone_id"]
    zone_name = config["zone_name"]
    cloudflare_console = f"https://dash.cloudflare.com/{account_id}/{zone_name}" if account_id and zone_name else "https://dash.cloudflare.com"
    expected_hosts = ["db.otmega.com", "files.otmega.com", "api.otmega.com"]
    missing_config = [key for key in ("api_token", "account_id", "zone_id", "zone_name") if not config.get(key)]

    if missing_config:
        return _resource(
            resource_id="cloudflare-workers",
            group="Edge",
            name="Cloudflare Workers",
            kind="Workers / DNS",
            status="unknown",
            summary="Cloudflare API is not integrated with this console runtime yet.",
            primary_url="https://dash.cloudflare.com",
            console_url=cloudflare_console,
            metrics=[
                _metric("integration", "not integrated", "unknown"),
                _metric("missing config", ", ".join(missing_config), "warn"),
                *[_metric(host, "not checked", "unknown") for host in expected_hosts],
            ],
            links=[
                _link("DB worker", "https://db.otmega.com"),
                _link("Files worker", "https://files.otmega.com"),
                _link("API domain", "https://api.otmega.com"),
            ],
        )

    start = time.perf_counter()
    probe_results: dict[str, dict] = {}
    failures: list[str] = []
    total_latency = 0
    endpoints = [
        ("scripts", f"accounts/{account_id}/workers/scripts"),
        ("dns", f"zones/{zone_id}/dns_records?per_page=100"),
        ("routes", f"zones/{zone_id}/workers/routes"),
    ]

    for label, path in endpoints:
        try:
            payload, http_status, latency_ms = _read_cloudflare_api(path, api_token)
            total_latency += latency_ms
            success = bool(payload.get("success")) and 200 <= http_status < 300
            if not success:
                failures.append(f"{label} returned success=false")
            probe_results[label] = {
                "payload": payload,
                "http_status": http_status,
                "success": success,
            }
        except urllib.error.HTTPError as exc:
            total_latency += _elapsed_ms(start)
            failures.append(_cloudflare_api_error_summary(exc, label))
            probe_results[label] = {"payload": {}, "http_status": exc.code, "success": False}
        except Exception as exc:
            total_latency += _elapsed_ms(start)
            failures.append(f"{label} probe failed: {type(exc).__name__}")
            probe_results[label] = {"payload": {}, "http_status": "failed", "success": False}

    scripts_payload = probe_results.get("scripts", {}).get("payload", {})
    dns_payload = probe_results.get("dns", {}).get("payload", {})
    routes_payload = probe_results.get("routes", {}).get("payload", {})
    scripts = _cloudflare_result_list(scripts_payload)
    dns_records = _cloudflare_result_list(dns_payload)
    routes = _cloudflare_result_list(routes_payload)
    scripts_count = _cloudflare_total(scripts_payload, len(scripts))
    dns_count = _cloudflare_total(dns_payload, len(dns_records))
    routes_count = _cloudflare_total(routes_payload, len(routes))
    host_metrics = []
    missing_hosts = []
    for host in expected_hosts:
        has_dns = _host_present(dns_records, host)
        has_route = _route_present(routes, host)
        if not has_dns and not has_route:
            missing_hosts.append(host)
        state = "ok" if has_dns or has_route else "warn"
        host_metrics.append(_metric(host, f"dns:{'yes' if has_dns else 'no'} route:{'yes' if has_route else 'no'}", state))

    if failures:
        status = "warn" if any("permission" in item or "HTTP 401" in item or "HTTP 403" in item for item in failures) else "error"
        summary = "; ".join(failures[:2])
    elif missing_hosts:
        status = "warn"
        summary = f"Cloudflare API is reachable, but expected DNS/route entries need review: {', '.join(missing_hosts)}."
    else:
        status = "ok"
        summary = "Cloudflare API read probes succeeded for Workers scripts, DNS records and Workers routes."

    return _resource(
        resource_id="cloudflare-workers",
        group="Edge",
        name="Cloudflare Workers",
        kind="Workers / DNS",
        status=status,
        summary=summary,
        primary_url="https://dash.cloudflare.com",
        console_url=cloudflare_console,
        latency_ms=total_latency or _elapsed_ms(start),
        metrics=[
            _metric("scripts", str(scripts_count), "ok" if probe_results.get("scripts", {}).get("success") else "warn"),
            _metric("routes", str(routes_count), "ok" if probe_results.get("routes", {}).get("success") else "warn"),
            _metric("dns records", str(dns_count), "ok" if probe_results.get("dns", {}).get("success") else "warn"),
            _metric("zone", zone_name, "ok"),
            *host_metrics,
        ],
        links=[
            _link("DB worker", "https://db.otmega.com"),
            _link("Files worker", "https://files.otmega.com"),
            _link("API domain", "https://api.otmega.com"),
            _link("Workers", f"{cloudflare_console}/workers-and-pages" if cloudflare_console else None),
            _link("DNS", f"{cloudflare_console}/dns/records" if cloudflare_console else None),
        ],
    )


def _supabase_project_id(url: str) -> str:
    configured = os.environ.get("PRG2_SUPABASE_PROJECT_ID") or os.environ.get("SUPABASE_PROJECT_ID")
    if configured:
        return configured
    parsed = urllib.parse.urlparse(url)
    host = parsed.hostname or ""
    return host.split(".")[0] if host.endswith(".supabase.co") else ""


def _supabase_base_url() -> str:
    return (os.environ.get("PRG2_SUPABASE_URL") or "https://db.otmega.com").rstrip("/")


def _supabase_service_role() -> str | None:
    return os.environ.get("PRG2_SUPABASE_SERVICE_ROLE_KEY")


def _supabase_headers() -> dict | None:
    service_role = _supabase_service_role()
    if not service_role:
        return None
    return {
        "Accept": "application/json",
        "apikey": service_role,
        "Authorization": f"Bearer {service_role}",
    }


def _utc_gte(hours: int) -> str:
    return f"gte.{(datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()}"


def _read_supabase_rows(table: str, params: dict[str, str], *, timeout: int = 6) -> tuple[list[dict], int, int]:
    headers = _supabase_headers()
    if not headers:
        raise RuntimeError("missing_service_role")

    query = urllib.parse.urlencode(params, safe=",().:*")
    url = f"{_supabase_base_url()}/rest/v1/{table}?{query}"
    start = time.perf_counter()
    probe_request = urllib.request.Request(url, headers=headers, method="GET")
    with urllib.request.urlopen(probe_request, timeout=timeout) as response:
        payload = response.read().decode("utf-8")
        rows = json.loads(payload or "[]")
        if not isinstance(rows, list):
            rows = []
        return rows, response.status, _elapsed_ms(start)


def _ok_or_warn_service_role_resource(
    *,
    resource_id: str,
    group: str,
    name: str,
    kind: str,
    summary: str,
    primary_url: str | None = None,
    metrics: list[dict] | None = None,
) -> dict:
    return _resource(
        resource_id=resource_id,
        group=group,
        name=name,
        kind=kind,
        status="warn",
        summary=summary,
        primary_url=primary_url,
        metrics=metrics or [_metric("service role", "missing", "warn")],
    )


def _check_supabase() -> dict:
    supabase_url = _supabase_base_url()
    service_role = _supabase_service_role()
    project_id = _supabase_project_id(supabase_url)
    console_url = f"https://supabase.com/dashboard/project/{project_id}" if project_id else None
    start = time.perf_counter()
    status = "warn"
    summary = "Supabase URL is configured; service-role probe is not available."
    row_count = "not checked"

    if service_role:
        query = urllib.parse.urlencode(
            {
                "select": "user_id",
                "advisor_id": f"eq.{ADVISOR_ID}",
                "limit": "1",
            },
            safe=",().",
        )
        rest_url = f"{supabase_url}/rest/v1/profiles?{query}"
        headers = {
            "Accept": "application/json",
            "apikey": service_role,
            "Authorization": f"Bearer {service_role}",
        }
        try:
            probe_request = urllib.request.Request(rest_url, headers=headers, method="GET")
            with urllib.request.urlopen(probe_request, timeout=6) as response:
                row_count = response.headers.get("Content-Range", "reachable")
                status = "ok" if 200 <= response.status < 300 else "warn"
                summary = f"profiles read probe returned HTTP {response.status}."
        except urllib.error.HTTPError as exc:
            status = "error"
            summary = f"profiles read probe returned HTTP {exc.code}."
        except Exception as exc:
            status = "error"
            summary = f"profiles read probe failed: {type(exc).__name__}."

    return _resource(
        resource_id="supabase-prg2",
        group="Data",
        name="Supabase PRG2",
        kind="Postgres/Auth/Realtime",
        status=status,
        summary=summary,
        primary_url=supabase_url,
        console_url=console_url,
        latency_ms=_elapsed_ms(start),
        metrics=[
            _metric("advisor_id", ADVISOR_ID),
            _metric("project", project_id or "unknown", "ok" if project_id else "warn"),
            _metric("profiles probe", row_count, status),
        ],
        links=[
            _link("SQL editor", f"{console_url}/sql/new?skip=true" if console_url else None),
            _link("Logs", f"{console_url}/logs/explorer" if console_url else None),
            _link("DB proxy", "https://db.otmega.com"),
        ],
    )


def _check_db_proxy_authenticated() -> dict:
    if not _supabase_service_role():
        return _ok_or_warn_service_role_resource(
            resource_id="cloudflare-db-proxy",
            group="Edge",
            name="DB Proxy",
            kind="Cloudflare Worker",
            summary="DB proxy is protected; authenticated probe needs PRG2_SUPABASE_SERVICE_ROLE_KEY.",
            primary_url="https://db.otmega.com",
        )

    try:
        rows, http_status, latency_ms = _read_supabase_rows(
            "profiles",
            {
                "select": "user_id",
                "advisor_id": f"eq.{ADVISOR_ID}",
                "limit": "1",
            },
        )
        status = "ok" if 200 <= http_status < 300 else "warn"
        summary = f"Authenticated DB proxy probe returned HTTP {http_status}."
        return _resource(
            resource_id="cloudflare-db-proxy",
            group="Edge",
            name="DB Proxy",
            kind="Cloudflare Worker",
            status=status,
            summary=summary,
            primary_url="https://db.otmega.com",
            latency_ms=latency_ms,
            metrics=[
                _metric("HTTP", str(http_status), status),
                _metric("sample rows", str(len(rows)), "ok" if rows else "warn"),
            ],
            links=[_link("REST probe", "https://db.otmega.com/rest/v1/profiles")],
        )
    except Exception as exc:
        return _resource(
            resource_id="cloudflare-db-proxy",
            group="Edge",
            name="DB Proxy",
            kind="Cloudflare Worker",
            status="error",
            summary=f"Authenticated DB proxy probe failed: {type(exc).__name__}.",
            primary_url="https://db.otmega.com",
            metrics=[_metric("probe", "failed", "error")],
        )


def _check_chat_activity() -> dict:
    if not _supabase_service_role():
        return _ok_or_warn_service_role_resource(
            resource_id="db-chat-activity",
            group="Data",
            name="Chat Activity",
            kind="Messages / WF1",
            summary="Chat activity probe needs PRG2_SUPABASE_SERVICE_ROLE_KEY.",
        )

    try:
        rows_1h, http_status, latency_ms = _read_supabase_rows(
            "messages",
            {
                "select": "id,status,type,content_pivot,text_translations,created_at",
                "advisor_id": f"eq.{ADVISOR_ID}",
                "created_at": _utc_gte(1),
                "limit": "1000",
            },
        )
        rows_24h, _, latency_24h = _read_supabase_rows(
            "messages",
            {
                "select": "id,status,type,created_at",
                "advisor_id": f"eq.{ADVISOR_ID}",
                "created_at": _utc_gte(24),
                "limit": "1000",
            },
        )
        failed_1h = sum(1 for row in rows_1h if row.get("status") == "failed")
        enriched_1h = sum(
            1
            for row in rows_1h
            if row.get("content_pivot") or (isinstance(row.get("text_translations"), dict) and row.get("text_translations"))
        )
        status = "warn" if failed_1h else "ok"
        return _resource(
            resource_id="db-chat-activity",
            group="Data",
            name="Chat Activity",
            kind="Messages / WF1",
            status=status,
            summary=f"Read-only message probe found {len(rows_1h)} messages in the last hour.",
            latency_ms=latency_ms + latency_24h,
            metrics=[
                _metric("1h messages", str(len(rows_1h)), "neutral"),
                _metric("24h messages", str(len(rows_24h)), "neutral"),
                _metric("1h failed", str(failed_1h), "warn" if failed_1h else "ok"),
                _metric("1h enriched", str(enriched_1h), "neutral"),
                _metric("HTTP", str(http_status), "ok"),
            ],
        )
    except Exception as exc:
        return _resource(
            resource_id="db-chat-activity",
            group="Data",
            name="Chat Activity",
            kind="Messages / WF1",
            status="error",
            summary=f"Chat activity probe failed: {type(exc).__name__}.",
            metrics=[_metric("probe", "failed", "error")],
        )


def _check_unread_pressure() -> dict:
    if not _supabase_service_role():
        return _ok_or_warn_service_role_resource(
            resource_id="db-unread-pressure",
            group="Data",
            name="Unread Pressure",
            kind="Conversation participants",
            summary="Unread pressure probe needs PRG2_SUPABASE_SERVICE_ROLE_KEY.",
        )

    try:
        rows, http_status, latency_ms = _read_supabase_rows(
            "conversation_participants",
            {"select": "unread_count", "limit": "5000"},
        )
        unread_values = [int(row.get("unread_count") or 0) for row in rows if isinstance(row, dict)]
        total_unread = sum(unread_values)
        rows_with_unread = sum(1 for value in unread_values if value > 0)
        max_unread = max(unread_values or [0])
        status = "warn" if max_unread >= 50 else "ok"
        return _resource(
            resource_id="db-unread-pressure",
            group="Data",
            name="Unread Pressure",
            kind="Conversation participants",
            status=status,
            summary="Unread counters are read directly from conversation_participants.",
            latency_ms=latency_ms,
            metrics=[
                _metric("total unread", str(total_unread), "neutral"),
                _metric("rows unread", str(rows_with_unread), "neutral"),
                _metric("max unread", str(max_unread), "warn" if max_unread >= 50 else "ok"),
                _metric("HTTP", str(http_status), "ok"),
            ],
        )
    except Exception as exc:
        return _resource(
            resource_id="db-unread-pressure",
            group="Data",
            name="Unread Pressure",
            kind="Conversation participants",
            status="error",
            summary=f"Unread pressure probe failed: {type(exc).__name__}.",
            metrics=[_metric("probe", "failed", "error")],
        )


def _check_profile_presence() -> dict:
    if not _supabase_service_role():
        return _ok_or_warn_service_role_resource(
            resource_id="db-profile-presence",
            group="Data",
            name="Profile Presence",
            kind="Profiles",
            summary="Profile presence probe needs PRG2_SUPABASE_SERVICE_ROLE_KEY.",
        )

    try:
        rows, http_status, latency_ms = _read_supabase_rows(
            "profiles",
            {
                "select": "online_status,role,tier",
                "advisor_id": f"eq.{ADVISOR_ID}",
                "limit": "5000",
            },
        )
        online = sum(1 for row in rows if row.get("online_status") == "online")
        away = sum(1 for row in rows if row.get("online_status") == "away")
        s_admin = sum(1 for row in rows if row.get("role") == "s_admin")
        return _resource(
            resource_id="db-profile-presence",
            group="Data",
            name="Profile Presence",
            kind="Profiles",
            status="ok",
            summary=f"Profile presence read {len(rows)} Collabra profiles for advisor {ADVISOR_ID}.",
            latency_ms=latency_ms,
            metrics=[
                _metric("profiles", str(len(rows)), "neutral"),
                _metric("online", str(online), "ok" if online else "neutral"),
                _metric("away", str(away), "neutral"),
                _metric("s_admin", str(s_admin), "neutral"),
                _metric("HTTP", str(http_status), "ok"),
            ],
        )
    except Exception as exc:
        return _resource(
            resource_id="db-profile-presence",
            group="Data",
            name="Profile Presence",
            kind="Profiles",
            status="error",
            summary=f"Profile presence probe failed: {type(exc).__name__}.",
            metrics=[_metric("probe", "failed", "error")],
        )


def _is_benign_fcm_failure(last_error: str | None) -> bool:
    """A failed record that reflects an absent/stale push destination, not a real send error.

    These come from normal device churn (app uninstalled, FCM token rotated) and the worker
    already cleans the offending token, so they must not keep the health card permanently yellow.
    """
    text = last_error or ""
    lowered = text.lower()
    return (
        text == "no_valid_fcm_tokens"
        or "unregistered" in lowered
        or "registration-token-not-registered" in lowered
        or lowered.startswith("fcm_http_404:")
    )


def _check_notification_state() -> dict:
    if not _supabase_service_role():
        return _ok_or_warn_service_role_resource(
            resource_id="db-notification-state",
            group="Edge",
            name="Notification State",
            kind="FCM worker / dedupe",
            summary="Notification state probe needs PRG2_SUPABASE_SERVICE_ROLE_KEY.",
        )

    try:
        rows, http_status, latency_ms = _read_supabase_rows(
            "message_notify_dedupe",
            {
                "select": "notify_state,route_selected,last_error,created_at,sent_at",
                "advisor_id": f"eq.{ADVISOR_ID}",
                "created_at": _utc_gte(24),
                "limit": "1000",
            },
        )
        sent = sum(1 for row in rows if row.get("notify_state") == "sent")
        failed_rows = [row for row in rows if row.get("notify_state") == "failed"]
        pending = sum(1 for row in rows if row.get("notify_state") == "pending")
        stale_token_failed = sum(1 for row in failed_rows if _is_benign_fcm_failure(row.get("last_error")))
        real_failed = len(failed_rows) - stale_token_failed
        # Only genuine send failures or stuck pending should raise the card; benign stale-token
        # churn (unregistered / no valid token) is expected and does not mean the worker is broken.
        status = "warn" if real_failed or pending else "ok"
        return _resource(
            resource_id="db-notification-state",
            group="Edge",
            name="Notification State",
            kind="FCM worker / dedupe",
            status=status,
            summary=(
                f"Notification dedupe read {len(rows)} rows (24h): {sent} sent, "
                f"{real_failed} real-failed, {stale_token_failed} stale-token, {pending} pending."
            ),
            latency_ms=latency_ms,
            metrics=[
                _metric("24h sent", str(sent), "ok" if sent else "neutral"),
                _metric("24h failed (real)", str(real_failed), "warn" if real_failed else "ok"),
                _metric("24h stale token", str(stale_token_failed), "neutral"),
                _metric("24h pending", str(pending), "warn" if pending else "ok"),
                _metric("HTTP", str(http_status), "ok"),
            ],
            links=[_link("Notification worker", "https://api.otmega.com")],
        )
    except Exception as exc:
        return _resource(
            resource_id="db-notification-state",
            group="Edge",
            name="Notification State",
            kind="FCM worker / dedupe",
            status="error",
            summary=f"Notification state probe failed: {type(exc).__name__}.",
            metrics=[_metric("probe", "failed", "error")],
        )


def _check_gcs() -> dict:
    bucket_name = os.environ.get("APP_DATA_BUCKET_NAME", "otmega-collabra-secure")
    start = time.perf_counter()
    status = "warn"
    summary = "Bucket name is configured; metadata probe is not available."
    location = "not checked"
    storage_class = "not checked"
    signer_email = "unknown"
    try:
        from google.api_core.exceptions import Forbidden, NotFound
        from google.cloud import storage

        client = storage.Client()
        credentials = getattr(client, "_credentials", None)
        signer_email = getattr(credentials, "service_account_email", None) or "runtime credential"
        bucket = client.bucket(bucket_name)
        try:
            bucket.reload(client=client)
        except Forbidden:
            status = "warn"
            summary = "GCS bucket exists in configuration, but the current signer cannot read bucket metadata."
            location = "permission denied"
            storage_class = "permission denied"
        except NotFound:
            status = "error"
            summary = "GCS bucket was not found with current credentials."
            location = "missing"
            storage_class = "missing"
        else:
            status = "ok"
            summary = "GCS bucket metadata is reachable."
            location = bucket.location or "unknown"
            storage_class = bucket.storage_class or "unknown"
    except Exception as exc:
        status = "error"
        summary = f"GCS metadata probe failed: {type(exc).__name__}."

    bucket_browser_url = f"https://console.cloud.google.com/storage/browser/{bucket_name}?project={PROJECT_ID}"
    return _resource(
        resource_id="gcs-collabra-secure",
        group="Storage",
        name="Collabra Secure Bucket",
        kind="Google Cloud Storage",
        status=status,
        summary=summary,
        primary_url="https://files.otmega.com",
        console_url=bucket_browser_url,
        latency_ms=_elapsed_ms(start),
        metrics=[
            _metric("bucket", bucket_name),
            _metric("location", location, status if location != "not checked" else "warn"),
            _metric("storage class", storage_class, status if storage_class != "not checked" else "warn"),
            _metric("credential", signer_email, "neutral"),
        ],
        links=[
            _link("Bucket browser", bucket_browser_url),
            _link("Files proxy", "https://files.otmega.com"),
        ],
    )


def _check_url(resource_id: str, group: str, name: str, kind: str, url: str, console_url: str | None = None) -> dict:
    start = time.perf_counter()
    status = "unknown"
    summary = "Endpoint was not checked."
    http_status = "not checked"
    try:
        probe_request = urllib.request.Request(url, headers={"User-Agent": "otmega-admin-console/1.0"}, method="GET")
        with urllib.request.urlopen(probe_request, timeout=5) as response:
            http_status = str(response.status)
            status = "ok" if response.status < 500 else "warn"
            summary = f"Public endpoint returned HTTP {response.status}."
    except urllib.error.HTTPError as exc:
        http_status = str(exc.code)
        status = "warn" if exc.code < 500 else "error"
        summary = f"Public endpoint returned HTTP {exc.code}."
    except Exception as exc:
        status = "error"
        summary = f"Public endpoint probe failed: {type(exc).__name__}."

    return _resource(
        resource_id=resource_id,
        group=group,
        name=name,
        kind=kind,
        status=status,
        summary=summary,
        primary_url=url,
        console_url=console_url,
        latency_ms=_elapsed_ms(start),
        metrics=[_metric("HTTP", http_status, status)],
    )


def _check_files_proxy() -> dict:
    url = "https://files.otmega.com"
    start = time.perf_counter()
    status = "unknown"
    summary = "Files proxy endpoint was not checked."
    http_status = "not checked"
    security_state = "not checked"

    try:
        probe_request = urllib.request.Request(url, headers={"User-Agent": "otmega-admin-console/1.0"}, method="GET")
        with urllib.request.urlopen(probe_request, timeout=5) as response:
            http_status = str(response.status)
            status = "ok" if response.status < 500 else "warn"
            security_state = "public response"
            summary = f"Files proxy returned HTTP {response.status}."
    except urllib.error.HTTPError as exc:
        http_status = str(exc.code)
        body = ""
        try:
            body = exc.read().decode("utf-8", errors="replace")
        except Exception:
            body = ""

        if exc.code in {400, 401, 403} and ("MissingSecurityHeader" in body or "Authorization" in body):
            status = "ok"
            security_state = "auth required"
            summary = "Files proxy is reachable and rejects unauthenticated root access as expected."
        else:
            status = "warn" if exc.code < 500 else "error"
            security_state = "unexpected response"
            summary = f"Files proxy returned HTTP {exc.code}."
    except Exception as exc:
        status = "error"
        security_state = "probe failed"
        summary = f"Files proxy probe failed: {type(exc).__name__}."

    return _resource(
        resource_id="cloudflare-files-proxy",
        group="Edge",
        name="Files Proxy",
        kind="Cloudflare Worker / GCS gateway",
        status=status,
        summary=summary,
        primary_url=url,
        latency_ms=_elapsed_ms(start),
        metrics=[
            _metric("HTTP", http_status, status),
            _metric("security", security_state, "ok" if status == "ok" else status),
        ],
        links=[_link("Root check", url)],
    )


def _check_collabra_api() -> dict:
    root_url = "https://api.otmega.com"
    probe_url = f"{root_url}/api/get_ui_settings"
    start = time.perf_counter()
    status = "unknown"
    summary = "Collabra API read probe was not checked."
    http_status = "not checked"
    probe_path = "/api/get_ui_settings"

    try:
        probe_request = urllib.request.Request(probe_url, headers={"User-Agent": "otmega-admin-console/1.0"}, method="GET")
        with urllib.request.urlopen(probe_request, timeout=6) as response:
            http_status = str(response.status)
            status = "ok" if 200 <= response.status < 300 else "warn"
            content_type = response.headers.get("Content-Type", "")
            summary = f"Collabra read-only UI settings endpoint returned HTTP {response.status}."
            if "application/json" not in content_type.lower():
                status = "warn"
                summary = f"Collabra API path returned HTTP {response.status}, but response is not JSON."
    except urllib.error.HTTPError as exc:
        http_status = str(exc.code)
        status = "warn" if exc.code < 500 else "error"
        summary = f"Collabra API read probe returned HTTP {exc.code}; health route/domain mapping needs review."
    except Exception as exc:
        status = "error"
        summary = f"Collabra API read probe failed: {type(exc).__name__}."

    return _resource(
        resource_id="backend-api-domain",
        group="Compute",
        name="Collabra API",
        kind="Cloud Run / API Domain",
        status=status,
        summary=summary,
        primary_url=root_url,
        latency_ms=_elapsed_ms(start),
        metrics=[
            _metric("HTTP", http_status, status),
            _metric("probe", probe_path, "neutral"),
        ],
        links=[
            _link("Read probe", probe_url),
            _link("Root", root_url),
        ],
    )


def _int_from_env(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        return default


def _check_transcript_runtime_capacity() -> dict:
    console_timeout = _int_from_env("GUNICORN_TIMEOUT_SECONDS", 30)
    backend_timeout = _int_from_env("MAIN_BACKEND_GUNICORN_TIMEOUT_SECONDS", 30)
    recommended_timeout = _int_from_env("TRANSCRIPT_RECOMMENDED_TIMEOUT_SECONDS", RECOMMENDED_TRANSCRIPT_TIMEOUT_SECONDS)

    status = "ok"
    summary = "Transcript runtime timeout is aligned with long-running SVLIP requests."
    if console_timeout < recommended_timeout or backend_timeout < recommended_timeout:
        status = "warn"
        summary = (
            f"Transcript can exceed worker timeout. Current console/backend timeout: "
            f"{console_timeout}s/{backend_timeout}s. Recommended: {recommended_timeout}s and otmega memory >= 1Gi."
        )

    return _resource(
        resource_id="transcript-runtime-capacity",
        group="Compute",
        name="Transcript Runtime Capacity",
        kind="Gunicorn / Cloud Run timeout",
        status=status,
        summary=summary,
        primary_url="https://otmega-console-90514070755.us-central1.run.app",
        console_url=(
            "https://console.cloud.google.com/run/detail/"
            f"{REGION}/otmega/metrics?project={PROJECT_ID}"
        ),
        metrics=[
            _metric("console timeout", f"{console_timeout}s", "ok" if console_timeout >= recommended_timeout else "warn"),
            _metric("backend timeout", f"{backend_timeout}s", "ok" if backend_timeout >= recommended_timeout else "warn"),
            _metric("recommended", f"{recommended_timeout}s", "neutral"),
            _metric("backend memory", ">= 1Gi", "neutral"),
        ],
        links=[
            _link("Backend Cloud Run", f"https://console.cloud.google.com/run/detail/{REGION}/otmega/metrics?project={PROJECT_ID}"),
            _link("Console Cloud Run", f"https://console.cloud.google.com/run/detail/{REGION}/otmega-console/metrics?project={PROJECT_ID}"),
        ],
    )


# Critical Collabra hosts that MUST be served through Cloudflare so Iran users work without VPN.
EDGE_ROUTING_HOSTS = [
    ("app.otmega.com", "https://app.otmega.com/"),
    ("api.otmega.com", "https://api.otmega.com/api/get_ui_settings"),
    ("db.otmega.com", "https://db.otmega.com/auth/v1/health"),
    ("files.otmega.com", "https://files.otmega.com/"),
]
# Direct Google Cloud Run host. The frontend must NOT call it directly (sanction regression marker).
EDGE_ROUTING_DIRECT_HOST = ("otmega-4utq3wq6ka-uc.a.run.app", "https://otmega-4utq3wq6ka-uc.a.run.app/")


def _probe_edge_signal(url: str, *, timeout: int = 6) -> dict:
    """Light read-only GET that captures whether a host is fronted by Cloudflare or hits Google directly."""
    start = time.perf_counter()
    server = ""
    cf_ray = ""
    http_status = "failed"
    error = None
    try:
        probe_request = urllib.request.Request(url, headers={"User-Agent": "otmega-admin-console/1.0"}, method="GET")
        with urllib.request.urlopen(probe_request, timeout=timeout) as response:
            http_status = str(response.status)
            server = response.headers.get("Server", "") or ""
            cf_ray = response.headers.get("CF-RAY", "") or ""
    except urllib.error.HTTPError as exc:
        http_status = str(exc.code)
        if exc.headers:
            server = exc.headers.get("Server", "") or ""
            cf_ray = exc.headers.get("CF-RAY", "") or ""
    except Exception as exc:
        error = type(exc).__name__

    return {
        "url": url,
        "http_status": http_status,
        "server": server or "(none)",
        "cf_ray_present": bool(cf_ray),
        "behind_cloudflare": bool(cf_ray) or ("cloudflare" in server.lower()),
        "is_google_frontend": "google frontend" in server.lower(),
        "error": error,
        "latency_ms": _elapsed_ms(start),
    }


def _check_edge_routing() -> dict:
    total_latency = 0
    metrics: list[dict] = []
    leaks: list[str] = []
    unreachable: list[str] = []

    for host, url in EDGE_ROUTING_HOSTS:
        signal = _probe_edge_signal(url)
        total_latency += signal["latency_ms"]
        if signal["error"]:
            unreachable.append(host)
            metrics.append(_metric(host, f"probe failed: {signal['error']}", "unknown"))
        elif signal["is_google_frontend"] or not signal["behind_cloudflare"]:
            leaks.append(host)
            metrics.append(_metric(host, f"NOT via Cloudflare - Server:{signal['server']} HTTP:{signal['http_status']}", "error"))
        else:
            cf_ray = "yes" if signal["cf_ray_present"] else "no"
            metrics.append(_metric(host, f"Cloudflare - CF-RAY:{cf_ray} HTTP:{signal['http_status']}", "ok"))

    direct_host, direct_url = EDGE_ROUTING_DIRECT_HOST
    direct_signal = _probe_edge_signal(direct_url)
    total_latency += direct_signal["latency_ms"]
    if direct_signal["error"]:
        metrics.append(_metric(direct_host, f"unreachable ({direct_signal['error']})", "neutral"))
    else:
        metrics.append(_metric(direct_host, f"Server:{direct_signal['server']} (frontend must not use this host)", "neutral"))

    if leaks:
        status = "error"
        summary = f"Sanction-bypass leak: {', '.join(leaks)} is not served through Cloudflare; Iran users without VPN will be blocked."
    elif unreachable:
        status = "warn"
        summary = f"Some edge hosts could not be probed from the console runtime: {', '.join(unreachable)}."
    else:
        status = "ok"
        summary = "All critical Collabra hosts (app, api, db, files) are served through Cloudflare; no direct-Google leak detected."

    return _resource(
        resource_id="edge-routing-sanction-bypass",
        group="Edge",
        name="Edge Routing / Sanction-Bypass",
        kind="Cloudflare front check",
        status=status,
        summary=summary,
        primary_url="https://app.otmega.com",
        latency_ms=total_latency,
        metrics=metrics,
        links=[
            _link("App", "https://app.otmega.com"),
            _link("API", "https://api.otmega.com"),
            _link("DB proxy", "https://db.otmega.com"),
            _link("Files proxy", "https://files.otmega.com"),
        ],
    )


def _static_resources(base_url: str) -> list[dict]:
    cloud_run_console = (
        "https://console.cloud.google.com/run/detail/"
        f"{REGION}/otmega-console/metrics?project={PROJECT_ID}"
    )
    return [
        _resource(
            resource_id="cloud-run-console",
            group="Compute",
            name="Admin Console Cloud Run",
            kind="Cloud Run",
            status="ok",
            summary="This Flask service is serving the current Admin Console session.",
            primary_url=base_url,
            console_url=cloud_run_console,
            metrics=[
                _metric("service", os.environ.get("K_SERVICE", "otmega-console")),
                _metric("region", REGION),
                _metric("project", PROJECT_ID),
            ],
        ),
    ]


@operational_bp.get("/api/console/operations/resources")
@require_capability("console.view_operational_status")
def operational_resources():
    base_url = request.host_url.rstrip("/")
    if current_app.testing:
        resources = [
            _resource(
                resource_id="supabase-prg2",
                group="Data",
                name="Supabase PRG2",
                kind="Postgres/Auth/Realtime",
                status="unknown",
                summary="Live probe is skipped during automated tests.",
                primary_url=os.environ.get("PRG2_SUPABASE_URL") or "https://db.otmega.com",
                metrics=[_metric("advisor_id", ADVISOR_ID)],
            ),
            _resource(
                resource_id="gcs-collabra-secure",
                group="Storage",
                name="Collabra Secure Bucket",
                kind="Google Cloud Storage",
                status="unknown",
                summary="Live probe is skipped during automated tests.",
                primary_url="https://files.otmega.com",
                metrics=[_metric("bucket", os.environ.get("APP_DATA_BUCKET_NAME", "otmega-collabra-secure"))],
            ),
            *_static_resources(base_url),
            _resource(
                resource_id="firebase-hosting",
                group="Frontend",
                name="Collabra Firebase Hosting",
                kind="Firebase Hosting",
                status="unknown",
                summary="Live probe is skipped during automated tests.",
                primary_url=FIREBASE_HOSTING_PRIMARY_URL,
                metrics=[_metric("probe", "skipped", "unknown")],
            ),
            _resource(
                resource_id="cloudflare-workers",
                group="Edge",
                name="Cloudflare Workers",
                kind="Workers / DNS",
                status="unknown",
                summary="Live probe is skipped during automated tests.",
                primary_url="https://dash.cloudflare.com",
                metrics=[_metric("probe", "skipped", "unknown")],
            ),
            _resource(
                resource_id="edge-routing-sanction-bypass",
                group="Edge",
                name="Edge Routing / Sanction-Bypass",
                kind="Cloudflare front check",
                status="unknown",
                summary="Live probe is skipped during automated tests.",
                primary_url="https://app.otmega.com",
                metrics=[_metric("probe", "skipped", "unknown")],
            ),
            _check_transcript_runtime_capacity(),
        ]
        return jsonify(
            {
                "status": "ok",
                "mode": "read_only",
                "write_enabled": False,
                "timestamp": _now_iso(),
                "resources": resources,
            }
        )

    resources = [
        _check_supabase(),
        _check_db_proxy_authenticated(),
        _check_chat_activity(),
        _check_unread_pressure(),
        _check_profile_presence(),
        _check_notification_state(),
        _check_gcs(),
        _check_files_proxy(),
        _check_collabra_api(),
        _check_transcript_runtime_capacity(),
        _check_edge_routing(),
        *_static_resources(base_url),
        _check_firebase_hosting(),
        _check_cloudflare_workers(),
    ]
    return jsonify(
        {
            "status": "ok",
            "mode": "read_only",
            "write_enabled": False,
            "timestamp": _now_iso(),
            "resources": resources,
        }
    )


@operational_bp.get("/api/console/operations/firebase-hosting/releases")
@require_capability("console.view_operational_status")
def firebase_hosting_releases():
    try:
        requested_limit = int(request.args.get("limit", "10"))
    except ValueError:
        requested_limit = 10

    try:
        releases, http_status, latency_ms = _read_firebase_hosting_releases(requested_limit)
        return jsonify(
            {
                "status": "ok",
                "mode": "read_only",
                "write_enabled": False,
                "project_id": PROJECT_ID,
                "site_id": FIREBASE_HOSTING_SITE_ID,
                "primary_url": FIREBASE_HOSTING_PRIMARY_URL,
                "console_url": _firebase_console_url(FIREBASE_HOSTING_SITE_ID),
                "http_status": http_status,
                "latency_ms": latency_ms,
                "timestamp": _now_iso(),
                "releases": releases,
            }
        )
    except urllib.error.HTTPError as exc:
        return (
            jsonify(
                {
                    "status": "error",
                    "mode": "read_only",
                    "write_enabled": False,
                    "message": f"Firebase Hosting releases probe returned HTTP {exc.code}.",
                    "http_status": exc.code,
                    "timestamp": _now_iso(),
                    "releases": [],
                }
            ),
            502,
        )


def _operational_logs_response(source: str, hours: int, severity: str, limit: int):
    readers = {
        "cloud-run-console": {
            "reader": _read_cloud_run_logs,
            "service": CONSOLE_CLOUD_RUN_SERVICE,
            "label": "Cloud Run logs",
            "permission": "Logging Viewer",
        },
        "cloud-build": {
            "reader": _read_cloud_build_logs,
            "service": "cloud-build",
            "label": "Cloud Build logs",
            "permission": "Logging Viewer",
        },
    }
    selected = readers.get(source)
    if not selected:
        return (
            jsonify(
                {
                    "status": "error",
                    "mode": "read_only",
                    "write_enabled": False,
                    "message": "Unsupported log source.",
                    "allowed_sources": sorted(readers.keys()),
                    "timestamp": _now_iso(),
                    "entries": [],
                }
            ),
            400,
        )

    try:
        entries, http_status, latency_ms = selected["reader"](hours=hours, severity=severity, limit=limit)
        return jsonify(
            {
                "status": "ok",
                "mode": "read_only",
                "write_enabled": False,
                "source": source,
                "project_id": PROJECT_ID,
                "region": REGION,
                "service": selected["service"],
                "hours": hours,
                "severity": severity,
                "limit": limit,
                "http_status": http_status,
                "latency_ms": latency_ms,
                "timestamp": _now_iso(),
                "entries": entries,
            }
        )
    except urllib.error.HTTPError as exc:
        message = f"{selected['label']} API returned HTTP {exc.code}."
        if exc.code in {401, 403}:
            message = f"{message} Service account needs {selected['permission']}."
        return (
            jsonify(
                {
                    "status": "error",
                    "mode": "read_only",
                    "write_enabled": False,
                    "source": source,
                    "project_id": PROJECT_ID,
                    "region": REGION,
                    "service": selected["service"],
                    "message": message,
                    "http_status": exc.code,
                    "timestamp": _now_iso(),
                    "entries": [],
                }
            ),
            502,
        )
    except Exception as exc:
        return (
            jsonify(
                {
                    "status": "error",
                    "mode": "read_only",
                    "write_enabled": False,
                    "source": source,
                    "project_id": PROJECT_ID,
                    "region": REGION,
                    "service": selected["service"],
                    "message": f"{selected['label']} probe failed: {type(exc).__name__}.",
                    "timestamp": _now_iso(),
                    "entries": [],
                }
            ),
            502,
        )


@operational_bp.get("/api/console/operations/logs")
@require_capability("console.view_operational_status")
def operational_logs():
    source = request.args.get("source", "cloud-run-console")
    hours = _bounded_int(request.args.get("hours"), 1, 1, 24)
    limit = _bounded_int(request.args.get("limit"), 50, 1, 100)
    severity = (request.args.get("severity") or "DEFAULT").upper()
    return _operational_logs_response(source, hours, severity, limit)

@operational_bp.get("/api/console/operations/logs/cloud-run")
@require_capability("console.view_operational_status")
def cloud_run_logs():
    hours = _bounded_int(request.args.get("hours"), 1, 1, 24)
    limit = _bounded_int(request.args.get("limit"), 50, 1, 100)
    severity = (request.args.get("severity") or "DEFAULT").upper()
    return _operational_logs_response("cloud-run-console", hours, severity, limit)
