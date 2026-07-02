import json

from app import create_app
from admin_api import live_translate_routes


def _login_user_zero(client, monkeypatch):
    monkeypatch.setenv("FALLBACK_ADMIN_USER", "root@example.com")
    monkeypatch.setenv("FALLBACK_ADMIN_PASS", "correct-pass")
    client.post("/api/console/login", json={"email": "root@example.com", "password": "correct-pass"})


def test_live_translate_requires_capability():
    app = create_app()
    client = app.test_client()

    response = client.get("/api/console/live-translate/config")

    assert response.status_code == 403


def test_live_translate_config_returns_model(monkeypatch):
    app = create_app()
    app.config["TESTING"] = True
    client = app.test_client()
    _login_user_zero(client, monkeypatch)

    response = client.get("/api/console/live-translate/config")

    payload = response.get_json()
    assert response.status_code == 200
    assert payload["model"] == "gemini-3.5-live-translate-preview"
    assert payload["input_audio"]["sample_rate_hz"] == 16000
    assert payload["auth"]["token_strategy"] == "ephemeral_v1alpha"
    assert payload["auth"]["connect_rpc"] == "BidiGenerateContentConstrained"
    assert payload["auth"]["token_query_param"] == "access_token"
    assert payload["auth"]["client_send_gate"] == "setup_complete"
    assert payload["auth"]["setup_shape"] == "github_live_translate_hybrid"
    assert payload["auth"]["token_constraint_mode"] == "ephemeral_unlocked_setup"
    assert any(item["code"] == "fa" for item in payload["supported_languages"])


def test_live_translate_session_token_uses_safe_target(monkeypatch):
    app = create_app()
    app.config["TESTING"] = True
    client = app.test_client()
    _login_user_zero(client, monkeypatch)

    calls = []

    def fake_create_token(target_language_code, echo_target_language):
        calls.append((target_language_code, echo_target_language))
        return {
            "access_token": "ephemeral-token",
            "expires_at": "2026-07-01T14:00:00Z",
            "new_session_expires_at": "2026-07-01T13:35:00Z",
        }, 42

    monkeypatch.setattr(live_translate_routes, "_create_ephemeral_token_with_timeout", fake_create_token)

    response = client.post(
        "/api/console/live-translate/session-token",
        json={"target_language_code": "fa", "echo_target_language": True},
    )

    payload = response.get_json()
    assert response.status_code == 200
    assert payload["access_token"] == "ephemeral-token"
    assert payload["target_language_code"] == "fa"
    assert payload["latency_ms"] == 42
    assert payload["auth_mode"] == "ephemeral_v1alpha"
    assert calls == [("fa", True)]


def test_live_translate_save_session_writes_expected_blobs(monkeypatch):
    app = create_app()
    app.config["TESTING"] = True
    client = app.test_client()
    _login_user_zero(client, monkeypatch)

    writes = {}

    class FakeBlob:
        def __init__(self, path):
            self.path = path

        def upload_from_string(self, data, content_type=None):
            writes[self.path] = {"data": data, "content_type": content_type}

    class FakeBucket:
        def blob(self, path):
            return FakeBlob(path)

    class FakeStorageClient:
        def bucket(self, name):
            assert name == live_translate_routes.BUCKET_NAME
            return FakeBucket()

    monkeypatch.setattr(live_translate_routes, "_storage_client", FakeStorageClient)

    response = client.post(
        "/api/console/live-translate/save-session",
        json={
            "session_id": "session one",
            "target_language_code": "tr",
            "input_transcript": [{"text": "سلام"}],
            "output_transcript": [{"text": "Merhaba"}],
            "source_audio_wav_base64": "UklGRg==",
            "metadata": {"frontend_log": [{"event": "test.event"}], "monitor": {"token": "issued"}},
        },
    )

    payload = response.get_json()
    assert response.status_code == 200
    assert payload["session_id"] == "session-one"
    assert f"{payload['prefix']}/session.json" in writes
    assert f"{payload['prefix']}/input_transcript.json" in writes
    assert f"{payload['prefix']}/output_transcript.json" in writes
    assert f"{payload['prefix']}/frontend_log.json" in writes
    assert f"{payload['prefix']}/backend_log.json" in writes
    assert f"{payload['prefix']}/source.wav" in writes
    session_json = json.loads(writes[f"{payload['prefix']}/session.json"]["data"])
    frontend_log = json.loads(writes[f"{payload['prefix']}/frontend_log.json"]["data"])
    backend_log = json.loads(writes[f"{payload['prefix']}/backend_log.json"]["data"])
    assert session_json["target_language_code"] == "tr"
    assert frontend_log[0]["event"] == "test.event"
    assert backend_log["monitor"]["token"] == "issued"


def test_live_translate_sessions_and_detail(monkeypatch):
    app = create_app()
    app.config["TESTING"] = True
    client = app.test_client()
    _login_user_zero(client, monkeypatch)

    class FakeBlob:
        def __init__(self, name, payload=None, updated="2026-07-01T15:30:00+00:00", size=12):
            self.name = name
            self._payload = payload
            self.updated = type("FakeDate", (), {"isoformat": lambda self: updated})()
            self.size = size
            self.content_type = "audio/wav" if name.endswith(".wav") else "application/json"

        def exists(self):
            return self._payload is not None or self.name.endswith(".wav")

        def download_as_text(self, encoding="utf-8"):
            return json.dumps(self._payload)

        def download_as_bytes(self):
            return b"RIFFtest"

        def reload(self):
            return None

        def generate_signed_url(self, version, expiration, method):
            return f"https://signed.example/{self.name}"

    class FakeBucket:
        def list_blobs(self, prefix):
            return [
                FakeBlob(f"{live_translate_routes.SESSION_PREFIX}/lt-test/session.json", {"session_id": "lt-test"}),
                FakeBlob(f"{live_translate_routes.SESSION_PREFIX}/lt-test/source.wav"),
            ]

        def blob(self, path):
            payloads = {
                f"{live_translate_routes.SESSION_PREFIX}/lt-test/session.json": {"session_id": "lt-test"},
                f"{live_translate_routes.SESSION_PREFIX}/lt-test/input_transcript.json": [],
                f"{live_translate_routes.SESSION_PREFIX}/lt-test/output_transcript.json": [{"text": "Hello", "language_code": "en", "created_at": "now"}],
                f"{live_translate_routes.SESSION_PREFIX}/lt-test/frontend_log.json": [{"event": "client"}],
                f"{live_translate_routes.SESSION_PREFIX}/lt-test/backend_log.json": {"event": "backend"},
            }
            return FakeBlob(path, payloads.get(path))

    class FakeStorageClient:
        def bucket(self, name):
            assert name == live_translate_routes.BUCKET_NAME
            return FakeBucket()

    monkeypatch.setattr(live_translate_routes, "_storage_client", FakeStorageClient)

    list_response = client.get("/api/console/live-translate/sessions")
    list_payload = list_response.get_json()
    assert list_response.status_code == 200
    assert list_payload["sessions"][0]["session_id"] == "lt-test"

    detail_response = client.get("/api/console/live-translate/session/lt-test")
    detail_payload = detail_response.get_json()
    assert detail_response.status_code == 200
    assert detail_payload["session"]["session_id"] == "lt-test"
    assert detail_payload["output_transcript"][0]["text"] == "Hello"
    assert detail_payload["frontend_log"][0]["event"] == "client"
    assert detail_payload["backend_log"]["event"] == "backend"
    assert detail_payload["source_audio_url"].startswith("https://signed.example/")
    assert detail_payload["source_audio_base64"]
    assert detail_payload["source_audio_mime_type"] == "audio/wav"
