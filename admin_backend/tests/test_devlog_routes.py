# FILE: ~/otmega/otmega_app/console/admin_backend/tests/test_devlog_routes.py
# ماموریت: تست lifecycle پرونده DevLog، مسیر GCS و شروع retention فقط پس از تأیید دانلود/رویداد دستی.

import datetime as dt
import json

from app import create_app
from admin_api import devlog_routes


class FakeBlob:
    def __init__(self, name, objects, metadata):
        self.name = name
        self._objects = objects
        self._metadata = metadata

    @property
    def size(self):
        value = self._objects.get(self.name, b"")
        return len(value.encode("utf-8") if isinstance(value, str) else value)

    @property
    def content_type(self):
        return self._metadata.get(self.name, {}).get("content_type")

    @property
    def updated(self):
        return self._metadata.get(self.name, {}).get("updated")

    def exists(self):
        return self.name in self._objects

    def download_as_text(self, encoding="utf-8"):
        value = self._objects[self.name]
        return value.decode(encoding) if isinstance(value, bytes) else value

    def upload_from_string(self, content, content_type=None):
        self._objects[self.name] = content
        self._metadata[self.name] = {"content_type": content_type, "updated": dt.datetime.now(dt.UTC)}

    def delete(self):
        self._objects.pop(self.name, None)
        self._metadata.pop(self.name, None)


class FakeBucket:
    def __init__(self, objects, metadata):
        self._objects = objects
        self._metadata = metadata

    def blob(self, name):
        return FakeBlob(name, self._objects, self._metadata)


class FakeStorageClient:
    def __init__(self):
        self.objects = {}
        self.metadata = {}

    def bucket(self, name):
        assert name == "otmega-collabra-secure"
        return FakeBucket(self.objects, self.metadata)

    def list_blobs(self, name, prefix=""):
        assert name == "otmega-collabra-secure"
        return [FakeBlob(path, self.objects, self.metadata) for path in sorted(self.objects) if path.startswith(prefix)]


def _login_user_zero(client, monkeypatch):
    monkeypatch.setenv("FALLBACK_ADMIN_USER", "root@example.com")
    monkeypatch.setenv("FALLBACK_ADMIN_PASS", "correct-pass")
    response = client.post("/api/console/login", json={"email": "root@example.com", "password": "correct-pass"})
    assert response.status_code == 200


def test_devlog_retention_waits_for_confirmed_download(monkeypatch):
    storage = FakeStorageClient()
    monkeypatch.setattr(devlog_routes, "_storage_client", storage)
    app = create_app()
    app.config["TESTING"] = True
    client = app.test_client()
    _login_user_zero(client, monkeypatch)

    created = client.post("/api/console/devlog/cases", json={
        "user_id": "11111111-1111-4111-8111-111111111111",
        "user_label": "debug@example.com",
        "capture_minutes": 30,
        "retention_days": 7,
    })
    assert created.status_code == 200
    case = created.get_json()["case"]
    case_id = case["manifest"]["case_id"]
    assert case["manifest"]["expires_at"] is None
    assert case["countdown"]["retention_started"] is False
    assert case["countdown"]["retention_remaining_seconds"] is None
    assert f"{devlog_routes.DEBUG_CASES_ROOT}/{case_id}/case.json" in storage.objects

    exported = client.get(f"/api/console/devlog/cases/{case_id}/export?format=json")
    assert exported.status_code == 200
    unchanged = client.get(f"/api/console/devlog/cases/{case_id}").get_json()["case"]
    assert unchanged["manifest"]["retention_started_at"] is None

    confirmed = client.post(f"/api/console/devlog/cases/{case_id}/download-confirmed")
    assert confirmed.status_code == 200
    retained = confirmed.get_json()["case"]
    assert retained["manifest"]["first_download_at"]
    assert retained["manifest"]["expires_at"]
    assert retained["countdown"]["retention_started"] is True
    assert retained["countdown"]["retention_remaining_seconds"] > 0


def test_devlog_manual_retention_records_manual_source(monkeypatch):
    storage = FakeStorageClient()
    monkeypatch.setattr(devlog_routes, "_storage_client", storage)
    app = create_app()
    app.config["TESTING"] = True
    client = app.test_client()
    _login_user_zero(client, monkeypatch)

    case_id = client.post("/api/console/devlog/cases", json={
        "user_id": "22222222-2222-4222-8222-222222222222",
    }).get_json()["case"]["manifest"]["case_id"]
    response = client.post(f"/api/console/devlog/cases/{case_id}/start-retention")
    manifest = response.get_json()["case"]["manifest"]

    assert response.status_code == 200
    assert manifest["retention_start_source"] == "manual"
    assert manifest["first_download_at"] is None


def test_devlog_exports_include_computed_trace_analytics(monkeypatch):
    storage = FakeStorageClient()
    monkeypatch.setattr(devlog_routes, "_storage_client", storage)
    message_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    message_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    notification_evidence = {
        "available": True,
        "source": "message_notify_dedupe",
        "query_latency_ms": 12,
        "reason_code": None,
        "counts": {"sent": 1},
        "rows": [{
            "message_id": message_1,
            "recipient_user_id": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            "route_selected": "push",
            "notify_state": "sent",
            "created_at": "2026-07-11T10:00:00Z",
            "sent_at": "2026-07-11T10:00:00.250Z",
            "last_attempt_at": "2026-07-11T10:00:00.250Z",
            "attempts": 1,
            "last_error_code": None,
            "created_to_sent_ms": 250.0,
        }],
    }
    monkeypatch.setattr(devlog_routes, "_load_notification_evidence", lambda events: notification_evidence)
    app = create_app()
    app.config["TESTING"] = True
    client = app.test_client()
    _login_user_zero(client, monkeypatch)

    case_id = client.post("/api/console/devlog/cases", json={
        "user_id": "33333333-3333-4333-8333-333333333333",
    }).get_json()["case"]["manifest"]["case_id"]
    device = {
        "device_session_ref": "device-test",
        "device_key": "ios_safari_pwa",
        "os": "ios",
        "browser": "safari",
        "runtime_kind": "pwa",
    }
    events = [
        {"event_id": "e1", "event_code": "DL-FE-OPTIMISTIC-CREATED", "trace_id": "trace-send", "client_mono_ms": 1000, "client_message_id": "client-1"},
        {"event_id": "e2", "event_code": "DL-FE-HTTP-START", "trace_id": "trace-send", "client_mono_ms": 1010, "client_message_id": "client-1"},
        {"event_id": "e3", "event_code": "DL-BE-SEND-RPC-COMPLETE", "trace_id": "trace-send", "client_mono_ms": 1200, "duration_ms": 150},
        {"event_id": "e4", "event_code": "DL-BE-SEND-SAVED", "trace_id": "trace-send", "client_mono_ms": 1500, "duration_ms": 450},
        {"event_id": "e5", "event_code": "DL-BE-SEND-POST-PROCESSING-COMPLETE", "trace_id": "trace-send", "client_mono_ms": 1550, "duration_ms": 500},
        {"event_id": "e6", "event_code": "DL-FE-HTTP-ACK", "trace_id": "trace-send", "client_mono_ms": 1810, "message_id": message_1},
        {"event_id": "e7", "event_code": "DL-FE-CANONICAL-OBSERVED", "trace_id": "trace-send", "client_mono_ms": 1800, "message_id": message_1},
        {"event_id": "e8", "event_code": "DL-FE-RECONCILE-DECISION", "trace_id": "trace-send", "client_mono_ms": 1920, "details": {"action": "replace"}},
        {"event_id": "e9", "event_code": "DL-FE-STATUS-DELIVERED-OBSERVED", "trace_id": "trace-send", "client_mono_ms": 2110, "message_id": message_1, "status": "delivered"},
        {"event_id": "e10", "event_code": "DL-FE-STATUS-READ-OBSERVED", "trace_id": "trace-send", "client_mono_ms": 2510, "message_id": message_1, "status": "read"},
        {"event_id": "e11", "event_code": "DL-FE-VISIBILITY-ENTER", "trace_id": "trace-send", "client_mono_ms": 2520, "message_id": message_1},
        {"event_id": "e12", "event_code": "DL-FE-CANONICAL-OBSERVED", "trace_id": "trace-received", "client_mono_ms": 3000, "message_id": message_2, "status": "sent"},
        {"event_id": "e13", "event_code": "DL-FE-VISIBILITY-ENTER", "trace_id": "trace-received", "client_mono_ms": 3100, "message_id": message_2},
        {"event_id": "e14", "event_code": "DL-FE-DELIVERED-ACK-COMPLETED", "trace_id": "trace-received", "client_mono_ms": 3200, "message_id": message_2, "status": "delivered"},
        {"event_id": "e15", "event_code": "DL-FE-READ-ACK-COMPLETED", "trace_id": "trace-received", "client_mono_ms": 3500, "message_id": message_2, "status": "read"},
    ]
    event_path = f"{devlog_routes.DEBUG_CASES_ROOT}/{case_id}/events/device-test/batch.json"
    storage.bucket("otmega-collabra-secure").blob(event_path).upload_from_string(json.dumps({"device": device, "events": events}), content_type="application/json")

    detail = client.get(f"/api/console/devlog/cases/{case_id}").get_json()["case"]
    analytics = detail["analytics"]
    trace = analytics["traces"][0]
    assert analytics["summary"]["outgoing_send_trace_count"] == 1
    assert analytics["latency_stats"]["http_start_to_ack_ms"]["avg_ms"] == 800.0
    assert trace["latency"]["backend_persist_after_rpc_ms"] == 300.0
    assert trace["latency"]["backend_post_after_saved_ms"] == 50.0
    assert trace["latency"]["http_start_to_delivered_observed_ms"] == 1100.0
    assert trace["latency"]["http_start_to_read_observed_ms"] == 1500.0
    assert trace["reconcile"]["replace"] == 1
    assert trace["attention_flags"] == []
    assert trace["ordering_notes"] == ["canonical_arrived_before_http_ack:10ms"]
    assert trace["message_id"] == message_1
    assert analytics["coverage"]["delivered_status"] is True
    assert analytics["coverage"]["read_status"] is True
    assert analytics["coverage"]["visibility_lifecycle"] is True
    assert analytics["coverage"]["worker_notification"] is True
    assert trace["notification_worker"]["states"] == {"sent": 1}
    assert analytics["latency_stats"]["worker_notification_created_to_sent_ms"]["avg_ms"] == 250.0
    assert analytics["interpretation"]["snapshot_status"] == "preliminary_active_capture"
    assert analytics["interpretation"]["confidence"] == "medium"
    assert analytics["interpretation"]["management_summary"]
    assert analytics["interpretation"]["technical_analysis"]
    assert any(item["path"].endswith("ChatContextV2.jsx") for item in analytics["interpretation"]["related_files"])
    assert any(item["path"].endswith("Develop_Log_Instrumentation_Protocol.md") for item in analytics["interpretation"]["related_documents"])

    json_export = client.get(f"/api/console/devlog/cases/{case_id}/export?format=json").get_json()
    csv_export = client.get(f"/api/console/devlog/cases/{case_id}/export?format=csv").get_data(as_text=True)
    md_export = client.get(f"/api/console/devlog/cases/{case_id}/export?format=md").get_data(as_text=True)
    html_response = client.get(f"/api/console/devlog/cases/{case_id}/export?format=html")
    html_export = html_response.get_data(as_text=True)
    assert json_export["analytics"]["summary"]["trace_count"] == 2
    assert "trace_analysis" in csv_export
    assert "http_start_to_ack_ms" in csv_export
    assert "worker_notification_evidence" in csv_export
    assert "case_analysis_reference" in csv_export
    assert "## Computed Analysis" in md_export
    assert "Per-trace Sequence and Latency" in md_export
    assert "CAPTURED — `delivered_status`" in md_export
    assert "Notification Worker Evidence" in md_export
    assert "Management Analysis" in md_export
    assert "Related Code Files" in md_export
    assert html_response.status_code == 200
    assert html_response.mimetype == "text/html"
    assert 'class="mermaid"' in html_export
    assert "DevLog Visual Message Path" in html_export
    assert "Sent messages — one graph per message" in html_export
    assert "Received messages — one graph per message" in html_export
    assert "trace-send" in html_export
    assert "trace-received" in html_export
    assert "Delivered observed" in html_export
    assert "Notification Worker" in html_export
    assert "Deterministic case analysis" in html_export
    assert "Management analysis" in html_export
    assert "Related code files, documents and limitations" in html_export
    assert "Ordering note" in html_export
    assert "canonical_arrived_before_http_ack:10ms" in html_export
    assert "No deterministic error flag captured" in html_export
    assert "cdn.jsdelivr.net/npm/mermaid@11" in html_export


def test_partial_outgoing_trace_is_not_misclassified_as_incoming():
    message_id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
    events = [
        {"event_code": "DL-FE-CANONICAL-OBSERVED", "trace_id": "chat_send_partial", "client_mono_ms": 100, "message_id": message_id, "client_message_id": "client-partial", "source": "frontend"},
        {"event_code": "DL-FE-HTTP-ACK", "trace_id": "chat_send_partial", "client_mono_ms": 180, "message_id": message_id, "client_message_id": "client-partial", "source": "frontend"},
        {"event_code": "DL-FE-RECONCILE-DECISION", "trace_id": "chat_send_partial", "client_mono_ms": 190, "message_id": message_id, "reason_code": "http_ack_identity_match", "details": {"action": "replace", "source": "http_ack_buffer"}, "source": "frontend"},
    ]
    analytics = devlog_routes._build_case_analytics(
        events,
        [],
        {"available": True, "source": "message_notify_dedupe", "rows": [], "counts": {}, "reason_code": "no_matching_worker_outcome"},
        {"status": "active"},
    )

    trace = analytics["traces"][0]
    assert trace["kind"] == "outgoing_partial"
    assert trace["evidence_gaps"] == ["missing_http_start", "missing_optimistic_created", "missing_backend_send_milestones"]
    assert analytics["summary"]["outgoing_send_trace_count"] == 1
    assert analytics["summary"]["outgoing_partial_trace_count"] == 1
    assert analytics["summary"]["observed_incoming_trace_count"] == 0
    assert analytics["coverage"]["http_start"] is False
    assert analytics["interpretation"]["classification"] == "no_failure_observed_partial_evidence"
    assert "Capture one fresh send" in analytics["interpretation"]["next_diagnostic_action"]
