# FILE: ~/otmega/otmega_app/console/admin_backend/tests/test_operational_routes.py
# ماموریت: تست probeهای read-only عملیاتی Admin Console بدون تماس شبکه واقعی.

import json

from app import create_app
from admin_api import operational_routes


class FakeResponse:
    def __init__(self, payload, status=200):
        self.payload = payload
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def read(self):
        return json.dumps(self.payload).encode("utf-8")


class FakeHeaderResponse:
    def __init__(self, status=200, headers=None):
        self.status = status
        self.headers = headers or {}

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False


def test_edge_routing_probe_reports_ok_when_all_cloudflare(monkeypatch):
    seen_methods = []

    def fake_urlopen(request, timeout):
        seen_methods.append(request.get_method())
        if request.full_url.startswith("https://otmega-4utq3wq6ka-uc.a.run.app"):
            return FakeHeaderResponse(status=200, headers={"Server": "Google Frontend"})
        return FakeHeaderResponse(status=200, headers={"Server": "cloudflare", "CF-RAY": "abc123-FRA"})

    monkeypatch.setattr(operational_routes.urllib.request, "urlopen", fake_urlopen)

    resource = operational_routes._check_edge_routing()

    assert resource["status"] == "ok"
    assert all(method == "GET" for method in seen_methods)
    metric_states = {metric["label"]: metric["state"] for metric in resource["metrics"]}
    assert metric_states["app.otmega.com"] == "ok"
    assert metric_states["api.otmega.com"] == "ok"
    assert metric_states["db.otmega.com"] == "ok"
    assert metric_states["files.otmega.com"] == "ok"


def test_edge_routing_probe_flags_direct_google_leak(monkeypatch):
    def fake_urlopen(request, timeout):
        if request.full_url.startswith("https://files.otmega.com"):
            return FakeHeaderResponse(status=200, headers={"Server": "Google Frontend"})
        if request.full_url.startswith("https://otmega-4utq3wq6ka-uc.a.run.app"):
            return FakeHeaderResponse(status=200, headers={"Server": "Google Frontend"})
        return FakeHeaderResponse(status=200, headers={"Server": "cloudflare", "CF-RAY": "abc123-FRA"})

    monkeypatch.setattr(operational_routes.urllib.request, "urlopen", fake_urlopen)

    resource = operational_routes._check_edge_routing()

    assert resource["status"] == "error"
    metric_states = {metric["label"]: metric["state"] for metric in resource["metrics"]}
    assert metric_states["files.otmega.com"] == "error"
    assert metric_states["app.otmega.com"] == "ok"


def test_notification_state_benign_stale_token_stays_ok(monkeypatch):
    monkeypatch.setattr(operational_routes, "_supabase_service_role", lambda: "service-role-key")
    monkeypatch.setattr(
        operational_routes,
        "_read_supabase_rows",
        lambda table, params: (
            [
                {"notify_state": "sent"},
                {"notify_state": "sent"},
                {"notify_state": "skipped", "last_error": "no_valid_fcm_tokens"},
                {
                    "notify_state": "failed",
                    "last_error": "fcm_http_404: {\"error\":{\"status\":\"NOT_FOUND\"}}",
                },
            ],
            200,
            12,
        ),
    )

    resource = operational_routes._check_notification_state()

    assert resource["status"] == "ok"
    metric_values = {metric["label"]: metric["value"] for metric in resource["metrics"]}
    assert metric_values["24h failed (real)"] == "0"
    assert metric_values["24h stale token"] == "1"


def test_notification_state_real_failure_warns(monkeypatch):
    monkeypatch.setattr(operational_routes, "_supabase_service_role", lambda: "service-role-key")
    monkeypatch.setattr(
        operational_routes,
        "_read_supabase_rows",
        lambda table, params: (
            [
                {"notify_state": "sent"},
                {"notify_state": "failed", "last_error": "fcm_http_500: internal error"},
            ],
            200,
            9,
        ),
    )

    resource = operational_routes._check_notification_state()

    assert resource["status"] == "warn"
    metric_values = {metric["label"]: metric["value"] for metric in resource["metrics"]}
    assert metric_values["24h failed (real)"] == "1"
    assert metric_values["24h stale token"] == "0"


def test_cloudflare_workers_probe_reports_ok_without_writes(monkeypatch):
    seen_requests = []

    def fake_urlopen(request, timeout):
        seen_requests.append((request.full_url, request.get_method()))
        if "/workers/scripts" in request.full_url:
            return FakeResponse(
                {
                    "success": True,
                    "result": [{"id": "db-proxy"}, {"id": "files-proxy"}, {"id": "notify-worker"}],
                    "result_info": {"total_count": 3},
                }
            )
        if "/dns_records" in request.full_url:
            return FakeResponse(
                {
                    "success": True,
                    "result": [
                        {"name": "db.otmega.com", "type": "CNAME"},
                        {"name": "files.otmega.com", "type": "CNAME"},
                        {"name": "api.otmega.com", "type": "CNAME"},
                    ],
                    "result_info": {"total_count": 17},
                }
            )
        if "/workers/routes" in request.full_url:
            return FakeResponse(
                {
                    "success": True,
                    "result": [
                        {"pattern": "db.otmega.com/*"},
                        {"pattern": "files.otmega.com/*"},
                        {"pattern": "api.otmega.com/*"},
                    ],
                    "result_info": {"total_count": 3},
                }
            )
        raise AssertionError(f"unexpected Cloudflare URL: {request.full_url}")

    monkeypatch.setenv("CLOUDFLARE_API_TOKEN", "secret-token")
    monkeypatch.setenv("CLOUDFLARE_ACCOUNT_ID", "account-id")
    monkeypatch.setenv("CLOUDFLARE_ZONE_ID", "zone-id")
    monkeypatch.setenv("CLOUDFLARE_ZONE_NAME", "otmega.com")
    monkeypatch.setattr(operational_routes.urllib.request, "urlopen", fake_urlopen)

    resource = operational_routes._check_cloudflare_workers()

    assert resource["status"] == "ok"
    assert all(method == "GET" for _, method in seen_requests)
    metric_values = {metric["label"]: metric["value"] for metric in resource["metrics"]}
    assert metric_values["scripts"] == "3"
    assert metric_values["routes"] == "3"
    assert metric_values["dns records"] == "17"
    assert metric_values["db.otmega.com"] == "dns:yes route:yes"
    assert metric_values["files.otmega.com"] == "dns:yes route:yes"
    assert metric_values["api.otmega.com"] == "dns:yes route:yes"


def test_cloudflare_workers_probe_stays_unknown_without_integration(monkeypatch):
    monkeypatch.delenv("CLOUDFLARE_API_TOKEN", raising=False)
    monkeypatch.delenv("CLOUDFLARE_ACCOUNT_ID", raising=False)
    monkeypatch.delenv("CLOUDFLARE_ZONE_ID", raising=False)
    monkeypatch.delenv("CLOUDFLARE_ZONE_NAME", raising=False)

    resource = operational_routes._check_cloudflare_workers()

    assert resource["status"] == "unknown"
    assert "not integrated" in resource["summary"]


def test_firebase_hosting_probe_reports_finalized_release(monkeypatch):
    seen_public_urls = []

    def fake_read_google_api(url, access_token):
        assert "firebasehosting.googleapis.com" in url
        assert access_token == "google-token"
        return (
            {
                "releases": [
                    {
                        "name": "projects/ot-ai-advisor/sites/ot-ai-advisor/releases/123",
                        "type": "DEPLOY",
                        "releaseTime": "2026-06-21T07:05:48.652Z",
                        "version": {
                            "name": "projects/ot-ai-advisor/sites/ot-ai-advisor/versions/version-1",
                            "status": "FINALIZED",
                            "fileCount": "567",
                            "versionBytes": "4849001",
                        },
                    }
                ]
            },
            200,
            42,
        )

    def fake_urlopen(request, timeout):
        seen_public_urls.append(request.full_url)
        return FakeResponse({}, status=200)

    monkeypatch.setattr(operational_routes, "_google_access_token", lambda scopes: "google-token")
    monkeypatch.setattr(operational_routes, "_read_google_api", fake_read_google_api)
    monkeypatch.setattr(operational_routes.urllib.request, "urlopen", fake_urlopen)

    resource = operational_routes._check_firebase_hosting()

    assert resource["status"] == "ok"
    assert seen_public_urls == ["https://app.otmega.com"]
    metric_values = {metric["label"]: metric["value"] for metric in resource["metrics"]}
    assert metric_values["site"] == "ot-ai-advisor"
    assert metric_values["release HTTP"] == "200"
    assert metric_values["public HTTP"] == "200"
    assert metric_values["release type"] == "DEPLOY"
    assert metric_values["version"] == "version-1"


def test_firebase_hosting_releases_endpoint_is_read_only(monkeypatch):
    monkeypatch.setenv("FALLBACK_ADMIN_USER", "root@example.com")
    monkeypatch.setenv("FALLBACK_ADMIN_PASS", "correct-pass")

    def fake_read_releases(page_size):
        assert page_size == 7
        return (
            [
                {
                    "name": "projects/ot-ai-advisor/sites/ot-ai-advisor/releases/123",
                    "type": "DEPLOY",
                    "release_time": "2026-06-21T10:30:00Z",
                    "release_user_email": "root@example.com",
                    "version": "version-123",
                    "version_status": "FINALIZED",
                    "file_count": "12",
                    "version_bytes": "4096",
                    "create_time": "2026-06-21T10:29:00Z",
                    "finalize_time": "2026-06-21T10:29:40Z",
                    "deployment_tool": "firebase-cli",
                }
            ],
            200,
            31,
        )

    monkeypatch.setattr(operational_routes, "_read_firebase_hosting_releases", fake_read_releases)

    app = create_app()
    app.config["TESTING"] = True
    client = app.test_client()

    client.post("/api/console/login", json={"email": "root@example.com", "password": "correct-pass"})
    response = client.get("/api/console/operations/firebase-hosting/releases?limit=7")

    payload = response.get_json()
    assert response.status_code == 200
    assert payload["mode"] == "read_only"
    assert payload["write_enabled"] is False
    assert payload["http_status"] == 200
    assert payload["latency_ms"] == 31
    assert payload["releases"][0]["version"] == "version-123"
    assert payload["releases"][0]["version_status"] == "FINALIZED"


def test_cloud_run_logs_endpoint_is_read_only(monkeypatch):
    monkeypatch.setenv("FALLBACK_ADMIN_USER", "root@example.com")
    monkeypatch.setenv("FALLBACK_ADMIN_PASS", "correct-pass")

    def fake_read_logs(*, hours, severity, limit):
        assert hours == 6
        assert severity == "WARNING"
        assert limit == 25
        return (
            [
                {
                    "timestamp": "2026-06-21T12:00:00Z",
                    "receive_timestamp": "2026-06-21T12:00:01Z",
                    "severity": "WARNING",
                    "message": "sample warning",
                    "log_name": "projects/ot-ai-advisor/logs/run.googleapis.com%2Frequests",
                    "insert_id": "abc123",
                    "revision": "otmega-console-00080-test",
                    "service": "otmega-console",
                    "location": "us-central1",
                    "http_method": "GET",
                    "request_url": "https://otmega-console.example/health",
                    "status": 200,
                    "latency": "0.123s",
                }
            ],
            200,
            44,
        )

    monkeypatch.setattr(operational_routes, "_read_cloud_run_logs", fake_read_logs)

    app = create_app()
    app.config["TESTING"] = True
    client = app.test_client()

    client.post("/api/console/login", json={"email": "root@example.com", "password": "correct-pass"})
    response = client.get("/api/console/operations/logs/cloud-run?hours=6&severity=WARNING&limit=25")

    payload = response.get_json()
    assert response.status_code == 200
    assert payload["mode"] == "read_only"
    assert payload["write_enabled"] is False
    assert payload["source"] == "cloud-run-console"
    assert payload["http_status"] == 200
    assert payload["entries"][0]["message"] == "sample warning"


def test_cloud_build_logs_source_is_read_only(monkeypatch):
    monkeypatch.setenv("FALLBACK_ADMIN_USER", "root@example.com")
    monkeypatch.setenv("FALLBACK_ADMIN_PASS", "correct-pass")

    def fake_read_logs(*, hours, severity, limit):
        assert hours == 24
        assert severity == "ERROR"
        assert limit == 50
        return (
            [
                {
                    "timestamp": "2026-06-21T13:00:00Z",
                    "receive_timestamp": "2026-06-21T13:00:01Z",
                    "severity": "ERROR",
                    "message": "build step failed",
                    "log_name": "projects/ot-ai-advisor/logs/cloudbuild",
                    "insert_id": "build-log-1",
                    "revision": "build-123",
                    "service": "cloud-build",
                    "location": "us-central1",
                    "http_method": None,
                    "request_url": None,
                    "status": None,
                    "latency": None,
                }
            ],
            200,
            58,
        )

    monkeypatch.setattr(operational_routes, "_read_cloud_build_logs", fake_read_logs)

    app = create_app()
    app.config["TESTING"] = True
    client = app.test_client()

    client.post("/api/console/login", json={"email": "root@example.com", "password": "correct-pass"})
    response = client.get("/api/console/operations/logs?source=cloud-build&hours=24&severity=ERROR&limit=50")

    payload = response.get_json()
    assert response.status_code == 200
    assert payload["mode"] == "read_only"
    assert payload["write_enabled"] is False
    assert payload["source"] == "cloud-build"
    assert payload["service"] == "cloud-build"
    assert payload["entries"][0]["revision"] == "build-123"


def test_cloud_build_log_item_extracts_deploy_summary():
    create_item = operational_routes._cloud_build_log_item(
        {
            "timestamp": "2026-06-21T14:00:00Z",
            "severity": "NOTICE",
            "protoPayload": {
                "methodName": "google.devtools.cloudbuild.v1.CloudBuild.CreateBuild",
                "serviceName": "cloudbuild.googleapis.com",
                "status": {},
            },
            "resource": {"labels": {"build_id": "build-1", "build_region": "us-central1"}},
        }
    )
    done_item = operational_routes._cloud_build_log_item(
        {
            "timestamp": "2026-06-21T14:01:00Z",
            "severity": "INFO",
            "textPayload": "DONE",
            "resource": {"labels": {"build_id": "build-1"}},
        }
    )
    digest_item = operational_routes._cloud_build_log_item(
        {
            "timestamp": "2026-06-21T14:02:00Z",
            "severity": "INFO",
            "textPayload": "latest: digest: sha256:bedfcdbee54323e55bb2978fa63809a557e3349",
            "resource": {"labels": {"build_id": "build-1"}},
        }
    )

    assert create_item["event"] == "create_build"
    assert done_item["event"] == "done"
    assert done_item["build_status"] == "done"
    assert digest_item["event"] == "artifact_digest"
    assert digest_item["build_status"] == "pushed"
    assert digest_item["artifact_digest"] == "sha256:bedfcdbee54323e55bb2978fa63809a557e3349"


def test_cloud_run_log_payload_redacts_sensitive_lines():
    item = operational_routes._cloud_run_log_item(
        {
            "timestamp": "2026-06-21T12:00:00Z",
            "severity": "ERROR",
            "textPayload": "before\nAuthorization: Bearer secret-token\nafter",
            "resource": {"labels": {"revision_name": "rev-1", "service_name": "otmega-console", "location": "us-central1"}},
        }
    )

    assert "secret-token" not in item["message"]
    assert "[redacted sensitive log line]" in item["message"]
