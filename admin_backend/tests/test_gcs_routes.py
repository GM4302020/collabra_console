from app import create_app
from admin_api import gcs_routes


def _login_user_zero(client, monkeypatch):
    monkeypatch.setenv("FALLBACK_ADMIN_USER", "root@example.com")
    monkeypatch.setenv("FALLBACK_ADMIN_PASS", "correct-pass")
    client.post("/api/console/login", json={"email": "root@example.com", "password": "correct-pass"})


def test_gcs_audio_context_resolves_message_participants_and_languages(monkeypatch):
    app = create_app()
    app.config["TESTING"] = True
    client = app.test_client()
    _login_user_zero(client, monkeypatch)

    blob_name = (
        "advisors/collabra-20018-v1.0.0/assets/chat/2026/06/24/"
        "11111111-1111-4111-8111-111111111111/audio/voice.m4a"
    )

    def fake_get_rows(table, params, timeout=10):
        if table == "messages":
            return [{
                "id": "msg-1",
                "conversation_id": "11111111-1111-4111-8111-111111111111",
                "sender_id": "sender-1",
                "advisor_id": 20018,
                "src_lang": "fa",
                "text_translations": {},
                "created_at": "2026-06-24T10:00:00Z",
                "status": "sent",
                "type": "audio",
                "metadata": {"file_path": blob_name, "message_type": "audio"},
                "client_message_id": "client-1",
            }]
        if table == "conversation_participants":
            return [
                {"conversation_id": "11111111-1111-4111-8111-111111111111", "user_id": "sender-1"},
                {"conversation_id": "11111111-1111-4111-8111-111111111111", "user_id": "receiver-1"},
            ]
        if table == "profiles":
            return [
                {
                    "user_id": "sender-1",
                    "advisor_id": 20018,
                    "email": "sender@example.com",
                    "full_name": "Sender",
                    "last_typed_lang": "fa",
                    "role": "user",
                    "country_code": "ir",
                },
                {
                    "user_id": "receiver-1",
                    "advisor_id": 20018,
                    "email": "receiver@example.com",
                    "full_name": "Receiver",
                    "last_typed_lang": "tr",
                    "role": "user",
                    "country_code": "tr",
                },
            ]
        return []

    monkeypatch.setattr(gcs_routes, "_supabase_get_rows", fake_get_rows)

    response = client.post("/api/console/gcs/audio-context", json={"blob_name": blob_name})

    payload = response.get_json()
    assert response.status_code == 200
    assert payload["status"] == "ok"
    assert payload["sender"]["email"] == "sender@example.com"
    assert payload["sender"]["language"] == "fa"
    assert payload["recipients"][0]["email"] == "receiver@example.com"
    assert payload["recipients"][0]["language"] == "tr"
    assert payload["recipients"][0]["language_source"] == "profiles.last_typed_lang_current"


def test_gcs_audio_context_reports_not_found(monkeypatch):
    app = create_app()
    app.config["TESTING"] = True
    client = app.test_client()
    _login_user_zero(client, monkeypatch)

    monkeypatch.setattr(gcs_routes, "_supabase_get_rows", lambda *_args, **_kwargs: [])

    response = client.post("/api/console/gcs/audio-context", json={"blob_name": "uploads/orphan.m4a"})

    payload = response.get_json()
    assert response.status_code == 200
    assert payload["status"] == "not_found"
