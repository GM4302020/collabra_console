# FILE: ~/otmega/otmega_app/console/admin_backend/tests/test_operational_routes.py
# ماموریت: تست probeهای read-only عملیاتی Admin Console بدون تماس شبکه واقعی.

import json

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
