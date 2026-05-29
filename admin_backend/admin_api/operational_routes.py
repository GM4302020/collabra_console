# FILE: ~/otmega/otmega_app/console/admin_backend/admin_api/operational_routes.py
# ماموریت: ارائه inventory و probe زنده زیرساخت های Collabra برای داشبورد Admin Console.

import os
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

from flask import Blueprint, current_app, jsonify, request

from admin_api.guards import require_capability

operational_bp = Blueprint("console_operational", __name__)


PROJECT_ID = os.environ.get("GOOGLE_CLOUD_PROJECT") or os.environ.get("GCP_PROJECT") or "ot-ai-advisor"
REGION = os.environ.get("CONSOLE_CLOUD_RUN_REGION") or os.environ.get("GOOGLE_CLOUD_REGION") or "us-central1"
ADVISOR_ID = os.environ.get("CONSOLE_ADVISOR_ID", "20018")


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


def _supabase_project_id(url: str) -> str:
    configured = os.environ.get("PRG2_SUPABASE_PROJECT_ID") or os.environ.get("SUPABASE_PROJECT_ID")
    if configured:
        return configured
    parsed = urllib.parse.urlparse(url)
    host = parsed.hostname or ""
    return host.split(".")[0] if host.endswith(".supabase.co") else ""


def _check_supabase() -> dict:
    supabase_url = (os.environ.get("PRG2_SUPABASE_URL") or "https://db.otmega.com").rstrip("/")
    service_role = os.environ.get("PRG2_SUPABASE_SERVICE_ROLE_KEY")
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


def _check_gcs() -> dict:
    bucket_name = os.environ.get("APP_DATA_BUCKET_NAME", "otmega-collabra-secure")
    start = time.perf_counter()
    status = "warn"
    summary = "Bucket name is configured; metadata probe is not available."
    location = "not checked"
    storage_class = "not checked"
    try:
        from google.cloud import storage

        client = storage.Client()
        bucket = client.bucket(bucket_name)
        if bucket.exists(client=client):
            bucket.reload(client=client)
            status = "ok"
            summary = "GCS bucket metadata is reachable."
            location = bucket.location or "unknown"
            storage_class = bucket.storage_class or "unknown"
        else:
            status = "error"
            summary = "GCS bucket was not found with current credentials."
            location = "missing"
            storage_class = "missing"
    except Exception as exc:
        status = "error"
        summary = f"GCS metadata probe failed: {type(exc).__name__}."

    return _resource(
        resource_id="gcs-collabra-secure",
        group="Storage",
        name="Collabra Secure Bucket",
        kind="Google Cloud Storage",
        status=status,
        summary=summary,
        primary_url="https://files.otmega.com",
        console_url=f"https://console.cloud.google.com/storage/browser/_details/{bucket_name}?project={PROJECT_ID}",
        latency_ms=_elapsed_ms(start),
        metrics=[
            _metric("bucket", bucket_name),
            _metric("location", location, status if location != "not checked" else "warn"),
            _metric("storage class", storage_class, status if storage_class != "not checked" else "warn"),
        ],
        links=[
            _link("Bucket browser", f"https://console.cloud.google.com/storage/browser/{bucket_name}?project={PROJECT_ID}"),
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


def _static_resources(base_url: str) -> list[dict]:
    cloud_run_console = (
        "https://console.cloud.google.com/run/detail/"
        f"{REGION}/otmega-console/metrics?project={PROJECT_ID}"
    )
    firebase_console = f"https://console.firebase.google.com/project/{PROJECT_ID}/hosting/sites"
    cloudflare_console = "https://dash.cloudflare.com"
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
        _resource(
            resource_id="firebase-hosting",
            group="Frontend",
            name="Collabra Firebase Hosting",
            kind="Firebase Hosting",
            status="unknown",
            summary="Hosting is documented for the main Collabra web frontend; admin API token is not attached to this console yet.",
            primary_url="https://app.otmega.com",
            console_url=firebase_console,
            metrics=[_metric("deployment", "external to console", "neutral")],
        ),
        _resource(
            resource_id="cloudflare-workers",
            group="Edge",
            name="Cloudflare Workers",
            kind="Workers / DNS",
            status="unknown",
            summary="Workers are documented for db, files and notification paths; Cloudflare API token is not attached yet.",
            primary_url="https://dash.cloudflare.com",
            console_url=cloudflare_console,
            metrics=[
                _metric("db worker", "db.otmega.com"),
                _metric("file worker", "files.otmega.com"),
                _metric("api domain", "api.otmega.com"),
            ],
            links=[
                _link("DB worker", "https://db.otmega.com"),
                _link("Files worker", "https://files.otmega.com"),
                _link("API domain", "https://api.otmega.com"),
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
        _check_gcs(),
        _check_url("cloudflare-db-proxy", "Edge", "DB Proxy", "Cloudflare Worker", "https://db.otmega.com/rest/v1/"),
        _check_url("cloudflare-files-proxy", "Edge", "Files Proxy", "Cloudflare Worker", "https://files.otmega.com"),
        _check_url("backend-api-domain", "Compute", "Collabra API", "Cloud Run / API Domain", "https://api.otmega.com/health"),
        *_static_resources(base_url),
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
