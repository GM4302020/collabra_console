import json

from app import create_app
from admin_api import supabase_monitor_routes


class FakeResponse:
    def __init__(self, payload, status=200, headers=None):
        self.payload = payload
        self.status = status
        self.headers = headers or {}

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def read(self):
        return json.dumps(self.payload).encode("utf-8")


def _login_user_zero(client, monkeypatch):
    monkeypatch.setenv("FALLBACK_ADMIN_USER", "root@example.com")
    monkeypatch.setenv("FALLBACK_ADMIN_PASS", "correct-pass")
    client.post("/api/console/login", json={"email": "root@example.com", "password": "correct-pass"})


def test_supabase_monitor_requires_capability():
    app = create_app()
    client = app.test_client()

    response = client.get("/api/console/supabase/database-overview")

    assert response.status_code == 403


def test_supabase_status_returns_statuspage_payload(monkeypatch):
    app = create_app()
    app.config["TESTING"] = True
    client = app.test_client()
    _login_user_zero(client, monkeypatch)

    def fake_urlopen(request, timeout):
        assert request.full_url == supabase_monitor_routes.STATUS_API_URL
        return FakeResponse(
            {
                "status": {"indicator": "minor", "description": "Partially Degraded Service"},
                "incidents": [{"name": "Project status change failures"}],
                "scheduled_maintenances": [],
            }
        )

    monkeypatch.setattr(supabase_monitor_routes.urllib.request, "urlopen", fake_urlopen)

    response = client.get("/api/console/supabase/status")

    payload = response.get_json()
    assert response.status_code == 200
    assert payload["indicator"] == "minor"
    assert payload["incidents"][0]["name"] == "Project status change failures"


def test_database_overview_includes_documented_field_counts(monkeypatch):
    app = create_app()
    app.config["TESTING"] = True
    client = app.test_client()
    _login_user_zero(client, monkeypatch)

    def fake_supabase_get(table, params, timeout=10, count=False):
        return [], 200, 3, "0-0/12"

    monkeypatch.setattr(supabase_monitor_routes, "_supabase_get", fake_supabase_get)

    response = client.get("/api/console/supabase/database-overview")

    payload = response.get_json()
    messages = next(row for row in payload["tables"] if row["name"] == "messages")
    assert response.status_code == 200
    assert messages["documented_field_count"] >= 15
    assert "metadata" in messages["documented_fields"]


def test_lip_wf1_audit_shapes_message_metadata(monkeypatch):
    app = create_app()
    app.config["TESTING"] = True
    client = app.test_client()
    _login_user_zero(client, monkeypatch)

    def fake_supabase_get(table, params, timeout=10, count=False):
        if table == "messages":
            return (
                [
                    {
                        "id": "msg-1",
                        "conversation_id": "conv-1",
                        "sender_id": "sender-1",
                        "advisor_id": 20018,
                        "content_original": "سلام",
                        "src_lang": "fa",
                        "content_pivot": "Hello",
                        "text_translations": {"tr": "Merhaba"},
                        "created_at": "2026-07-01T10:00:00Z",
                        "status": "sent",
                        "type": "text",
                        "client_message_id": "client-1",
                        "metadata": {
                            "message_language_context": {
                                "phase": "wf1_settled",
                                "source_lang": "fa",
                                "target_langs": ["tr"],
                                "targets": [{"user_id": "receiver-1", "target_lang": "tr"}],
                            },
                            "wf1_translation_model": {
                                "requested": {"provider": "google", "model": "gemini-2.5-pro"},
                                "actual": {"provider": "google", "model": "gemini-2.5-pro"},
                                "used_fallback": False,
                                "selection_reason": "primary",
                            },
                        },
                    }
                ],
                200,
                8,
                None,
            )
        if table == "profiles":
            return (
                [
                    {"user_id": "sender-1", "email": "sender@example.com", "full_name": "Sender"},
                    {"user_id": "receiver-1", "email": "receiver@example.com", "full_name": "Receiver"},
                ],
                200,
                4,
                None,
            )
        raise AssertionError(f"unexpected table: {table}")

    monkeypatch.setattr(supabase_monitor_routes, "_supabase_get", fake_supabase_get)

    response = client.get("/api/console/supabase/lip-wf1-audit?limit=3")

    payload = response.get_json()
    row = payload["rows"][0]
    assert response.status_code == 200
    assert row["sender"]["email"] == "sender@example.com"
    assert row["recipients"][0]["email"] == "receiver@example.com"
    assert row["source_lang"] == "fa"
    assert row["target_langs"] == ["tr"]
    assert row["actual_model"] == "gemini-2.5-pro"
    assert row["used_fallback"] is False
    assert row["raw_fields"]["content_original"] == "سلام"
    assert row["raw_fields"]["metadata"]["wf1_translation_model"]["selection_reason"] == "primary"
