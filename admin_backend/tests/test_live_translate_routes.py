import json

import pytest

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
    monkeypatch.delenv("ELEVENLABS_API_KEY", raising=False)

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
    assert payload["runtime_controls"]["source_voice_clone_modes"] == ["none", "google", "elevenlabs"]
    clone_providers = payload["runtime_controls"]["source_voice_clone_providers"]
    assert clone_providers["google"]["execution_wired"] is True
    assert clone_providers["elevenlabs"]["required_secret_env"] == "ELEVENLABS_API_KEY"
    assert clone_providers["elevenlabs"]["execution_wired"] is True
    assert clone_providers["elevenlabs"]["fallback_reason"] == "elevenlabs_api_key_missing"
    assert any(item["code"] == "fa" for item in payload["supported_languages"])
    assert payload["runtime_settings_path"] == live_translate_routes.RUNTIME_SETTINGS_PATH


def test_live_translate_runtime_settings_get_creates_default(monkeypatch):
    app = create_app()
    app.config["TESTING"] = True
    client = app.test_client()
    _login_user_zero(client, monkeypatch)
    writes = {}

    class FakeBlob:
        def __init__(self, path):
            self.path = path

        def exists(self):
            return self.path in writes

        def download_as_text(self, encoding="utf-8"):
            return writes[self.path]["data"]

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

    response = client.get("/api/console/live-translate/runtime-settings?profile=ios")

    payload = response.get_json()
    assert response.status_code == 200
    assert payload["created"] is True
    assert payload["path"] == live_translate_routes.RUNTIME_SETTINGS_PATH
    assert payload["effective_profile"] == "general"
    assert payload["effective_settings"]["cloneSourceVoiceMode"] == "none"
    assert live_translate_routes.RUNTIME_SETTINGS_PATH in writes
    stored = json.loads(writes[live_translate_routes.RUNTIME_SETTINGS_PATH]["data"])
    assert stored["profiles"]["general"]["audioChunkMs"] == 250


def test_live_translate_runtime_settings_save_profile(monkeypatch):
    app = create_app()
    app.config["TESTING"] = True
    client = app.test_client()
    _login_user_zero(client, monkeypatch)
    writes = {}

    class FakeBlob:
        def __init__(self, path):
            self.path = path

        def exists(self):
            return self.path in writes

        def download_as_text(self, encoding="utf-8"):
            return writes[self.path]["data"]

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
        "/api/console/live-translate/runtime-settings",
        json={
            "profile_key": "ios",
            "active_profile": "ios",
            "settings": {
                "targetLang": "fa",
                "audioChunkMs": 300,
                "cloneSourceVoiceMode": "elevenlabs",
                "elevenLabsCloneMode": "transcript_tts",
                "cloneVoiceAlias": "voice-123",
                "cloneConsentVersion": "voice-consent-v1",
            },
            "elevenlabs_voice_profiles": [
                {"email": "Speaker@Example.COM", "voice_id": "voice-123", "consent_version": "voice-consent-v1"}
            ],
        },
    )

    payload = response.get_json()
    assert response.status_code == 200
    assert payload["active_profile"] == "ios"
    assert payload["effective_profile"] == "ios"
    assert payload["effective_settings"]["targetLang"] == "fa"
    assert payload["effective_settings"]["cloneSourceVoiceMode"] == "elevenlabs"
    assert payload["document"]["elevenlabs_voice_profiles"][0]["email"] == "speaker@example.com"

    response = client.get("/api/console/live-translate/runtime-settings?profile=ios")
    payload = response.get_json()
    assert response.status_code == 200
    assert payload["effective_profile"] == "ios"
    assert payload["effective_settings"]["cloneVoiceAlias"] == "voice-123"


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


def test_live_translate_clone_preflight_reports_missing_elevenlabs_key(monkeypatch):
    app = create_app()
    app.config["TESTING"] = True
    client = app.test_client()
    _login_user_zero(client, monkeypatch)
    monkeypatch.delenv("ELEVENLABS_API_KEY", raising=False)

    response = client.post(
        "/api/console/live-translate/source-voice-clone-preflight",
        json={"provider": "elevenlabs", "provider_mode": "speech_to_speech", "target_language_code": "en"},
    )

    payload = response.get_json()
    assert response.status_code == 200
    assert payload["provider"] == "elevenlabs"
    assert payload["can_execute"] is False
    assert payload["fallback_active"] is True
    assert payload["fallback_reason"] == "elevenlabs_api_key_missing"
    assert "ELEVENLABS_API_KEY" in payload["missing"]
    assert "elevenlabs_api_key_missing" in payload["blockers"]


def test_live_translate_clone_preflight_requires_elevenlabs_voice_id(monkeypatch):
    app = create_app()
    app.config["TESTING"] = True
    client = app.test_client()
    _login_user_zero(client, monkeypatch)
    monkeypatch.setenv("ELEVENLABS_API_KEY", "test-elevenlabs-key")

    response = client.post(
        "/api/console/live-translate/source-voice-clone-preflight",
        json={"provider": "elevenlabs", "provider_mode": "transcript_tts", "target_language_code": "en"},
    )

    payload = response.get_json()
    assert response.status_code == 200
    assert payload["provider"] == "elevenlabs"
    assert payload["can_execute"] is False
    assert payload["fallback_reason"] == "elevenlabs_voice_id_missing"
    assert "ElevenLabs voice_id" in payload["missing"]
    assert "elevenlabs_voice_id_missing" in payload["blockers"]


def test_live_translate_elevenlabs_voice_profile_create_returns_voice_id(monkeypatch):
    app = create_app()
    app.config["TESTING"] = True
    client = app.test_client()
    _login_user_zero(client, monkeypatch)
    monkeypatch.setenv("ELEVENLABS_API_KEY", "test-elevenlabs-key")

    writes = {}

    class FakeBlob:
        def __init__(self, path):
            self.path = path
            self.name = path
            self.size = 960000 if path.endswith("source.wav") else 120
            self.content_type = "audio/wav" if path.endswith("source.wav") else "application/json; charset=utf-8"

        def exists(self):
            return self.path.endswith("source.wav") or self.path.endswith("session.json")

        def reload(self):
            return None

        def download_as_bytes(self):
            return b"RIFFtest"

        def download_as_text(self, encoding="utf-8"):
            return json.dumps({"metadata": {"monitor": {"sourceSeconds": 45}}})

        def upload_from_string(self, data, content_type=None):
            writes[self.path] = {"data": data, "content_type": content_type}

    class FakeBucket:
        def blob(self, path):
            return FakeBlob(path)

    class FakeStorageClient:
        def bucket(self, name):
            assert name == live_translate_routes.BUCKET_NAME
            return FakeBucket()

    class FakeResponse:
        ok = True
        status_code = 200
        text = '{"voice_id":"voice-abc","requires_verification":false}'

        def json(self):
            return {"voice_id": "voice-abc", "requires_verification": False}

    calls = []

    def fake_post(url, **kwargs):
        calls.append({"url": url, **kwargs})
        return FakeResponse()

    import requests

    monkeypatch.setattr(live_translate_routes, "_storage_client", FakeStorageClient)
    monkeypatch.setattr(requests, "post", fake_post)

    response = client.post(
        "/api/console/live-translate/elevenlabs-voice-profile-create",
        json={
            "session_id": "lt-test",
            "speaker_email": "Speaker@Example.COM",
            "consent_version": "voice-consent-v1",
        },
    )

    payload = response.get_json()
    assert response.status_code == 200
    assert payload["status"] == "completed"
    assert payload["speaker_email"] == "speaker@example.com"
    assert payload["voice_id"] == "voice-abc"
    assert payload["source_seconds"] == 45
    assert payload["voice_profile_result_path"].endswith("/voice_profile_result.json")
    assert payload["saved_paths"] == [payload["voice_profile_result_path"]]
    assert payload["voice_profile_result_path"] in writes
    assert calls[0]["url"].endswith("/voices/add")
    assert calls[0]["data"]["name"] == "speaker@example.com"
    assert calls[0]["files"][0][0] == "files[]"


def test_live_translate_elevenlabs_voice_profile_create_blocks_missing_consent_without_external_call(monkeypatch):
    app = create_app()
    app.config["TESTING"] = True
    client = app.test_client()
    _login_user_zero(client, monkeypatch)
    monkeypatch.setenv("ELEVENLABS_API_KEY", "test-elevenlabs-key")

    writes = {}

    class FakeBlob:
        def __init__(self, path):
            self.path = path
            self.size = 960000 if path.endswith("source.wav") else 120
            self.content_type = "audio/wav" if path.endswith("source.wav") else "application/json; charset=utf-8"

        def exists(self):
            return self.path.endswith("source.wav") or self.path.endswith("session.json")

        def reload(self):
            return None

        def download_as_text(self, encoding="utf-8"):
            return json.dumps({"metadata": {"monitor": {"sourceSeconds": 45}}})

        def upload_from_string(self, data, content_type=None):
            writes[self.path] = {"data": data, "content_type": content_type}

    class FakeBucket:
        def blob(self, path):
            return FakeBlob(path)

    class FakeStorageClient:
        def bucket(self, name):
            return FakeBucket()

    def fake_post(*args, **kwargs):
        raise AssertionError("ElevenLabs API must not be called without consent marker")

    import requests

    monkeypatch.setattr(live_translate_routes, "_storage_client", FakeStorageClient)
    monkeypatch.setattr(requests, "post", fake_post)

    response = client.post(
        "/api/console/live-translate/elevenlabs-voice-profile-create",
        json={
            "session_id": "lt-test",
            "speaker_email": "speaker@example.com",
            "consent_version": "",
        },
    )

    payload = response.get_json()
    assert response.status_code == 200
    assert payload["status"] == "blocked"
    assert payload["external_api_called"] is False
    assert "voice_consent_missing" in payload["blockers"]
    assert payload["voice_profile_result_path"] in writes


def test_live_translate_elevenlabs_voice_profile_create_blocks_short_source_without_external_call(monkeypatch):
    app = create_app()
    app.config["TESTING"] = True
    client = app.test_client()
    _login_user_zero(client, monkeypatch)
    monkeypatch.setenv("ELEVENLABS_API_KEY", "test-elevenlabs-key")

    writes = {}

    class FakeBlob:
        def __init__(self, path):
            self.path = path
            self.size = 240000 if path.endswith("source.wav") else 120
            self.content_type = "audio/wav" if path.endswith("source.wav") else "application/json; charset=utf-8"

        def exists(self):
            return self.path.endswith("source.wav") or self.path.endswith("session.json")

        def reload(self):
            return None

        def download_as_text(self, encoding="utf-8"):
            return json.dumps({"metadata": {"monitor": {"sourceSeconds": 7.5}}})

        def upload_from_string(self, data, content_type=None):
            writes[self.path] = {"data": data, "content_type": content_type}

    class FakeBucket:
        def blob(self, path):
            return FakeBlob(path)

    class FakeStorageClient:
        def bucket(self, name):
            return FakeBucket()

    def fake_post(*args, **kwargs):
        raise AssertionError("ElevenLabs API must not be called for a too-short IVC sample")

    import requests

    monkeypatch.setattr(live_translate_routes, "_storage_client", FakeStorageClient)
    monkeypatch.setattr(requests, "post", fake_post)

    response = client.post(
        "/api/console/live-translate/elevenlabs-voice-profile-create",
        json={
            "session_id": "lt-test",
            "speaker_email": "speaker@example.com",
            "consent_version": "voice-consent-v1",
        },
    )

    payload = response.get_json()
    assert response.status_code == 200
    assert payload["status"] == "blocked"
    assert payload["external_api_called"] is False
    assert payload["source_seconds"] == 7.5
    assert payload["min_source_seconds"] == 30
    assert "source_audio_too_short_for_ivc" in payload["blockers"]
    assert payload["voice_profile_result_path"] in writes


def test_live_translate_elevenlabs_voice_profile_create_maps_paid_plan_required(monkeypatch):
    app = create_app()
    app.config["TESTING"] = True
    client = app.test_client()
    _login_user_zero(client, monkeypatch)
    monkeypatch.setenv("ELEVENLABS_API_KEY", "test-elevenlabs-key")

    writes = {}

    class FakeBlob:
        def __init__(self, path):
            self.path = path
            self.size = 1600000 if path.endswith("source.wav") else 120
            self.content_type = "audio/wav" if path.endswith("source.wav") else "application/json; charset=utf-8"

        def exists(self):
            return self.path.endswith("source.wav") or self.path.endswith("session.json")

        def reload(self):
            return None

        def download_as_bytes(self):
            return b"RIFFtest"

        def download_as_text(self, encoding="utf-8"):
            return json.dumps({"metadata": {"monitor": {"sourceSeconds": 50.4}}})

        def upload_from_string(self, data, content_type=None):
            writes[self.path] = {"data": data, "content_type": content_type}

    class FakeBucket:
        def blob(self, path):
            return FakeBlob(path)

    class FakeStorageClient:
        def bucket(self, name):
            return FakeBucket()

    class FakeResponse:
        ok = False
        status_code = 400
        text = json.dumps(
            {
                "detail": {
                    "type": "payment_required",
                    "code": "paid_plan_required",
                    "message": "Your subscription does not include instant voice cloning. Please upgrade your plan.",
                    "status": "can_not_use_instant_voice_cloning",
                }
            }
        )

        def json(self):
            return json.loads(self.text)

    def fake_post(*args, **kwargs):
        return FakeResponse()

    import requests

    monkeypatch.setattr(live_translate_routes, "_storage_client", FakeStorageClient)
    monkeypatch.setattr(requests, "post", fake_post)

    response = client.post(
        "/api/console/live-translate/elevenlabs-voice-profile-create",
        json={
            "session_id": "lt-test",
            "speaker_email": "speaker@example.com",
            "consent_version": "voice-consent-v1",
        },
    )

    payload = response.get_json()
    assert response.status_code == 200
    assert payload["status"] == "failed"
    assert payload["external_api_called"] is True
    assert payload["fallback_reason"] == "elevenlabs_paid_plan_required"
    assert payload["provider_error_code"] == "paid_plan_required"
    assert payload["provider_error_type"] == "payment_required"
    assert payload["provider_error_status"] == "can_not_use_instant_voice_cloning"
    assert payload["source_seconds"] == 50.4
    assert payload["voice_profile_result_path"] in writes
    result_json = json.loads(writes[payload["voice_profile_result_path"]]["data"])
    assert result_json["fallback_reason"] == "elevenlabs_paid_plan_required"


def test_live_translate_clone_plan_writes_audit_blob(monkeypatch):
    app = create_app()
    app.config["TESTING"] = True
    client = app.test_client()
    _login_user_zero(client, monkeypatch)

    writes = {}

    class FakeBlob:
        def __init__(self, path, exists=True):
            self.path = path
            self._exists = exists

        def exists(self):
            return self._exists or self.path.endswith("session.json") or self.path.endswith("source.wav") or self.path.endswith("target.wav")

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
        "/api/console/live-translate/source-voice-clone-plan",
        json={
            "session_id": "lt-test",
            "provider": "google",
            "provider_mode": "chirp_instant_custom_voice",
            "target_language_code": "en",
            "voice_alias": "speaker-profile",
            "consent_version": "voice-consent-v1",
        },
    )

    payload = response.get_json()
    assert response.status_code == 200
    assert payload["status"] == "ok"
    assert payload["plan"]["status"] == "blocked_fallback_to_no_clone"
    plan_path = f"{live_translate_routes.SESSION_PREFIX}/lt-test/clone_plan.json"
    assert plan_path in writes
    plan_json = json.loads(writes[plan_path]["data"])
    assert plan_json["external_api_called"] is False
    assert plan_json["outputs"]["target_cloned_audio_path"].endswith("/target_cloned.wav")
    assert "google_adc_missing" in plan_json["blockers"]
    assert "google_voice_cloning_key_missing" in plan_json["blockers"]


def test_live_translate_clone_execute_elevenlabs_writes_cloned_audio(monkeypatch):
    app = create_app()
    app.config["TESTING"] = True
    client = app.test_client()
    _login_user_zero(client, monkeypatch)
    monkeypatch.setenv("ELEVENLABS_API_KEY", "test-elevenlabs-key")

    writes = {}

    class FakeBlob:
        def __init__(self, path):
            self.path = path
            self.name = path
            self.size = 8 if path.endswith(".wav") else 0
            self.content_type = "audio/wav" if path.endswith(".wav") else "application/json"

        def exists(self):
            return self.path.endswith("session.json") or self.path.endswith("source.wav") or self.path.endswith("target.wav")

        def reload(self):
            return None

        def download_as_bytes(self):
            return b"RIFFtest"

        def download_as_text(self, encoding="utf-8"):
            return json.dumps({"session_id": "lt-test"})

        def upload_from_string(self, data, content_type=None):
            writes[self.path] = {"data": data, "content_type": content_type}

    class FakeBucket:
        def blob(self, path):
            return FakeBlob(path)

    class FakeStorageClient:
        def bucket(self, name):
            assert name == live_translate_routes.BUCKET_NAME
            return FakeBucket()

    class FakeResponse:
        ok = True
        status_code = 200
        content = b"mp3-bytes"
        text = ""

    calls = []

    def fake_post(url, **kwargs):
        calls.append({"url": url, **kwargs})
        return FakeResponse()

    import requests

    monkeypatch.setattr(live_translate_routes, "_storage_client", FakeStorageClient)
    monkeypatch.setattr(requests, "post", fake_post)

    response = client.post(
        "/api/console/live-translate/source-voice-clone-execute",
        json={
            "session_id": "lt-test",
            "provider": "elevenlabs",
            "provider_mode": "speech_to_speech",
            "target_language_code": "en",
            "voice_alias": "voice123",
            "consent_version": "voice-consent-v1",
            "save_cloned_audio": True,
            "fallback_to_live_translate_audio": True,
        },
    )

    payload = response.get_json()
    assert response.status_code == 200
    assert payload["result"]["status"] == "completed"
    assert calls[0]["url"].endswith("/speech-to-speech/voice123")
    assert calls[0]["data"]["model_id"] == live_translate_routes.ELEVENLABS_STS_MODEL_ID
    cloned_path = f"{live_translate_routes.SESSION_PREFIX}/lt-test/target_cloned.mp3"
    result_path = f"{live_translate_routes.SESSION_PREFIX}/lt-test/clone_result.json"
    assert cloned_path in writes
    assert writes[cloned_path]["data"] == b"mp3-bytes"
    assert writes[cloned_path]["content_type"] == "audio/mpeg"
    assert result_path in writes
    result_json = json.loads(writes[result_path]["data"])
    assert result_json["external_api_called"] is True
    assert result_json["saved_cloned_audio"] is True


def test_live_translate_clone_execute_elevenlabs_falls_back_to_transcript_tts_without_target_audio(monkeypatch):
    app = create_app()
    app.config["TESTING"] = True
    client = app.test_client()
    _login_user_zero(client, monkeypatch)
    monkeypatch.setenv("ELEVENLABS_API_KEY", "test-elevenlabs-key")

    writes = {}

    class FakeBlob:
        def __init__(self, path):
            self.path = path
            self.name = path
            self.size = 0
            self.content_type = "application/json"

        def exists(self):
            return self.path.endswith("session.json") or self.path.endswith("output_transcript.json")

        def reload(self):
            return None

        def download_as_text(self, encoding="utf-8"):
            if self.path.endswith("output_transcript.json"):
                return json.dumps([{"text": "Hello cloned world", "language_code": "en"}])
            return json.dumps({"session_id": "lt-test"})

        def upload_from_string(self, data, content_type=None):
            writes[self.path] = {"data": data, "content_type": content_type}

    class FakeBucket:
        def blob(self, path):
            return FakeBlob(path)

    class FakeStorageClient:
        def bucket(self, name):
            assert name == live_translate_routes.BUCKET_NAME
            return FakeBucket()

    class FakeResponse:
        ok = True
        status_code = 200
        content = b"tts-mp3-bytes"
        text = ""

    calls = []

    def fake_post(url, **kwargs):
        calls.append({"url": url, **kwargs})
        return FakeResponse()

    import requests

    monkeypatch.setattr(live_translate_routes, "_storage_client", FakeStorageClient)
    monkeypatch.setattr(requests, "post", fake_post)

    response = client.post(
        "/api/console/live-translate/source-voice-clone-execute",
        json={
            "session_id": "lt-test",
            "provider": "elevenlabs",
            "provider_mode": "speech_to_speech",
            "target_language_code": "en",
            "voice_alias": "voice123",
            "consent_version": "voice-consent-v1",
            "save_cloned_audio": True,
            "fallback_to_live_translate_audio": True,
        },
    )

    payload = response.get_json()
    assert response.status_code == 200
    assert payload["result"]["status"] == "completed"
    assert payload["result"]["requested_provider_mode"] == "speech_to_speech"
    assert payload["result"]["provider_mode"] == "transcript_tts"
    assert payload["result"]["mode_fallback_reason"] == "target_audio_missing_transcript_tts_fallback"
    assert calls[0]["url"].endswith("/text-to-speech/voice123")
    assert calls[0]["json"]["text"] == "Hello cloned world"
    cloned_path = f"{live_translate_routes.SESSION_PREFIX}/lt-test/target_cloned.mp3"
    result_path = f"{live_translate_routes.SESSION_PREFIX}/lt-test/clone_result.json"
    assert cloned_path in writes
    assert writes[cloned_path]["data"] == b"tts-mp3-bytes"
    assert result_path in writes


def test_live_translate_clone_execute_elevenlabs_blocks_missing_voice_id_without_external_call(monkeypatch):
    app = create_app()
    app.config["TESTING"] = True
    client = app.test_client()
    _login_user_zero(client, monkeypatch)
    monkeypatch.setenv("ELEVENLABS_API_KEY", "test-elevenlabs-key")

    writes = {}

    class FakeBlob:
        def __init__(self, path):
            self.path = path
            self.name = path
            self.size = 0
            self.content_type = "application/json"

        def exists(self):
            return self.path.endswith("session.json") or self.path.endswith("output_transcript.json")

        def upload_from_string(self, data, content_type=None):
            writes[self.path] = {"data": data, "content_type": content_type}

    class FakeBucket:
        def blob(self, path):
            return FakeBlob(path)

    class FakeStorageClient:
        def bucket(self, name):
            assert name == live_translate_routes.BUCKET_NAME
            return FakeBucket()

    def fake_post(*args, **kwargs):
        raise AssertionError("ElevenLabs API must not be called without voice_id")

    import requests

    monkeypatch.setattr(live_translate_routes, "_storage_client", FakeStorageClient)
    monkeypatch.setattr(requests, "post", fake_post)

    response = client.post(
        "/api/console/live-translate/source-voice-clone-execute",
        json={
            "session_id": "lt-test",
            "provider": "elevenlabs",
            "provider_mode": "speech_to_speech",
            "target_language_code": "en",
            "voice_alias": "",
            "save_cloned_audio": True,
            "fallback_to_live_translate_audio": True,
        },
    )

    payload = response.get_json()
    assert response.status_code == 200
    assert payload["result"]["status"] == "blocked_fallback_to_no_clone"
    assert payload["result"]["fallback_reason"] == "elevenlabs_voice_id_missing"
    assert payload["result"]["external_api_called"] is False
    result_path = f"{live_translate_routes.SESSION_PREFIX}/lt-test/clone_result.json"
    assert result_path in writes


@pytest.mark.parametrize(
    ("status_code", "expected_reason", "expected_message"),
    [
        (401, "elevenlabs_invalid_api_key", "Invalid ElevenLabs API key."),
        (403, "elevenlabs_forbidden_or_restricted_key", "Access forbidden or API key restriction issue."),
        (429, "elevenlabs_rate_limit_or_quota", "Rate limit or quota issue."),
        (404, "elevenlabs_voice_not_found_or_endpoint", "ElevenLabs voice_id was not found or the endpoint is not available for this key."),
        (500, "elevenlabs_provider_server_error", "ElevenLabs provider server error."),
    ],
)
def test_live_translate_clone_execute_elevenlabs_maps_http_errors(monkeypatch, status_code, expected_reason, expected_message):
    app = create_app()
    app.config["TESTING"] = True
    client = app.test_client()
    _login_user_zero(client, monkeypatch)
    monkeypatch.setenv("ELEVENLABS_API_KEY", "test-elevenlabs-key")

    writes = {}

    class FakeBlob:
        def __init__(self, path):
            self.path = path
            self.name = path
            self.size = 0
            self.content_type = "application/json"

        def exists(self):
            return self.path.endswith("session.json") or self.path.endswith("output_transcript.json")

        def reload(self):
            return None

        def download_as_text(self, encoding="utf-8"):
            if self.path.endswith("output_transcript.json"):
                return json.dumps([{"text": "Hello world", "language_code": "en"}])
            return json.dumps({"session_id": "lt-test"})

        def upload_from_string(self, data, content_type=None):
            writes[self.path] = {"data": data, "content_type": content_type}

    class FakeBucket:
        def blob(self, path):
            return FakeBlob(path)

    class FakeStorageClient:
        def bucket(self, name):
            assert name == live_translate_routes.BUCKET_NAME
            return FakeBucket()

    class FakeResponse:
        ok = False
        content = b""

        def __init__(self, status_code):
            self.status_code = status_code
            self.text = f"provider error {status_code}"

    def fake_post(*args, **kwargs):
        return FakeResponse(status_code)

    import requests

    monkeypatch.setattr(live_translate_routes, "_storage_client", FakeStorageClient)
    monkeypatch.setattr(requests, "post", fake_post)

    response = client.post(
        "/api/console/live-translate/source-voice-clone-execute",
        json={
            "session_id": "lt-test",
            "provider": "elevenlabs",
            "provider_mode": "transcript_tts",
            "target_language_code": "en",
            "voice_alias": "voice123",
            "save_cloned_audio": True,
            "fallback_to_live_translate_audio": True,
        },
    )

    payload = response.get_json()
    assert response.status_code == 200
    assert payload["result"]["status"] == "failed_fallback_to_no_clone"
    assert payload["result"]["fallback_reason"] == expected_reason
    assert payload["result"]["provider_error_message"] == expected_message
    assert payload["result"]["provider_http_status"] == status_code
    result_path = f"{live_translate_routes.SESSION_PREFIX}/lt-test/clone_result.json"
    assert result_path in writes
    result_json = json.loads(writes[result_path]["data"])
    assert result_json["blockers"] == [expected_reason]
    assert result_json["provider_error_sample"] == f"provider error {status_code}"


def test_live_translate_clone_execute_google_writes_cloned_audio(monkeypatch):
    app = create_app()
    app.config["TESTING"] = True
    client = app.test_client()
    _login_user_zero(client, monkeypatch)
    monkeypatch.setenv("K_SERVICE", "otmega-console")
    monkeypatch.setenv("GOOGLE_TTS_VOICE_CLONING_KEY", "test-google-voice-key")
    monkeypatch.setenv("GOOGLE_TTS_PROJECT_ID", "ot-ai-advisor")
    monkeypatch.setattr(live_translate_routes, "GOOGLE_TTS_VOICE_CLONING_KEY", "test-google-voice-key")
    monkeypatch.setattr(live_translate_routes, "GOOGLE_TTS_PROJECT_ID", "ot-ai-advisor")

    writes = {}

    class FakeBlob:
        def __init__(self, path):
            self.path = path
            self.name = path
            self.size = 8 if path.endswith(".wav") else 0
            self.content_type = "audio/wav" if path.endswith(".wav") else "application/json"

        def exists(self):
            return self.path.endswith("session.json") or self.path.endswith("output_transcript.json") or self.path.endswith("target.wav")

        def reload(self):
            return None

        def download_as_bytes(self):
            return b"RIFFtest"

        def download_as_text(self, encoding="utf-8"):
            if self.path.endswith("output_transcript.json"):
                return json.dumps([{"text": "Hello world", "language_code": "en"}])
            return json.dumps({"session_id": "lt-test"})

        def upload_from_string(self, data, content_type=None):
            writes[self.path] = {"data": data, "content_type": content_type}

    class FakeBucket:
        def blob(self, path):
            return FakeBlob(path)

    class FakeStorageClient:
        def bucket(self, name):
            assert name == live_translate_routes.BUCKET_NAME
            return FakeBucket()

    class FakeResponse:
        ok = True
        status_code = 200
        text = ""

        def json(self):
            return {"audioContent": "UklGRmdvb2dsZQ=="}

    calls = []

    def fake_access_token():
        return "access-token", "ot-ai-advisor"

    def fake_post(url, **kwargs):
        calls.append({"url": url, **kwargs})
        return FakeResponse()

    import requests

    monkeypatch.setattr(live_translate_routes, "_storage_client", FakeStorageClient)
    monkeypatch.setattr(live_translate_routes, "_google_tts_access_token", fake_access_token)
    monkeypatch.setattr(requests, "post", fake_post)

    response = client.post(
        "/api/console/live-translate/source-voice-clone-execute",
        json={
            "session_id": "lt-test",
            "provider": "google",
            "provider_mode": "chirp_instant_custom_voice",
            "target_language_code": "en",
            "consent_version": "voice-consent-v1",
            "save_cloned_audio": True,
            "fallback_to_live_translate_audio": True,
        },
    )

    payload = response.get_json()
    assert response.status_code == 200
    assert payload["result"]["status"] == "completed"
    assert calls[0]["url"].endswith("/v1beta1/text:synthesize")
    assert calls[0]["headers"]["Authorization"] == "Bearer access-token"
    assert calls[0]["headers"]["x-goog-user-project"] == "ot-ai-advisor"
    assert calls[0]["json"]["voice"]["voice_clone"]["voice_cloning_key"] == "test-google-voice-key"
    assert calls[0]["json"]["input"]["text"] == "Hello world"
    cloned_path = f"{live_translate_routes.SESSION_PREFIX}/lt-test/target_cloned.wav"
    result_path = f"{live_translate_routes.SESSION_PREFIX}/lt-test/clone_result.json"
    assert cloned_path in writes
    assert writes[cloned_path]["data"] == b"RIFFgoogle"
    assert writes[cloned_path]["content_type"] == "audio/wav"
    assert result_path in writes
    result_json = json.loads(writes[result_path]["data"])
    assert result_json["external_api_called"] is True
    assert result_json["saved_cloned_audio"] is True
    assert result_json["voice_reference"] is None
    assert "test-google-voice-key" not in writes[result_path]["data"]


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
            self.content_type = "audio/mpeg" if name.endswith(".mp3") else "audio/wav" if name.endswith(".wav") else "application/json"

        def exists(self):
            return self._payload is not None or self.name.endswith(".wav") or self.name.endswith(".mp3")

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
                f"{live_translate_routes.SESSION_PREFIX}/lt-test/clone_plan.json": {"status": "blocked_fallback_to_no_clone"},
                f"{live_translate_routes.SESSION_PREFIX}/lt-test/clone_result.json": {"status": "completed"},
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
    assert detail_payload["clone_plan"]["status"] == "blocked_fallback_to_no_clone"
    assert detail_payload["clone_result"]["status"] == "completed"
    assert detail_payload["source_audio_url"].startswith("https://signed.example/")
    assert detail_payload["target_cloned_audio_url"].startswith("https://signed.example/")
    assert detail_payload["source_audio_base64"]
    assert detail_payload["source_audio_mime_type"] == "audio/wav"
    assert detail_payload["target_cloned_audio_mime_type"] == "audio/mpeg"


def test_live_conversation_guard_requires_capability():
    app = create_app()
    client = app.test_client()

    response = client.get("/api/console/live-translate/live-conversation-guard")

    assert response.status_code == 403


def test_live_conversation_guard_read_fails_without_supabase_env(monkeypatch):
    app = create_app()
    app.config["TESTING"] = True
    client = app.test_client()
    _login_user_zero(client, monkeypatch)
    monkeypatch.delenv("PRG2_SUPABASE_URL", raising=False)
    monkeypatch.delenv("PRG2_SUPABASE_SERVICE_ROLE_KEY", raising=False)

    response = client.get("/api/console/live-translate/live-conversation-guard")

    payload = response.get_json()
    assert response.status_code == 502
    assert payload["status"] == "error"
    assert "guard read failed" in payload["message"]


def test_live_conversation_guard_update_requires_boolean(monkeypatch):
    app = create_app()
    app.config["TESTING"] = True
    client = app.test_client()
    _login_user_zero(client, monkeypatch)

    response = client.post(
        "/api/console/live-translate/live-conversation-guard",
        json={"enabled": "yes"},
    )

    payload = response.get_json()
    assert response.status_code == 400
    assert payload["status"] == "error"


def test_live_conversation_guard_update_toggles_and_logs(monkeypatch):
    app = create_app()
    app.config["TESTING"] = True
    client = app.test_client()
    _login_user_zero(client, monkeypatch)

    monkeypatch.setattr(
        live_translate_routes,
        "_fetch_live_conversation_guard",
        lambda: ({"enabled": True, "max_sessions_per_user_per_day": 20}, {
            "enabled": True, "max_sessions_per_user_per_day": 20,
            "max_session_seconds": 600, "updated_at": "t0", "version": 1,
        }),
    )
    monkeypatch.setattr(
        live_translate_routes,
        "_update_live_conversation_guard_enabled",
        lambda enabled: {
            "enabled": enabled, "max_sessions_per_user_per_day": 20,
            "max_session_seconds": 600, "updated_at": "t1", "version": 1,
        },
    )
    appended = []

    def _fake_append(entry):
        appended.append(entry)
        return appended

    monkeypatch.setattr(live_translate_routes, "_append_guard_log", _fake_append)

    response = client.post(
        "/api/console/live-translate/live-conversation-guard",
        json={"enabled": False},
    )

    payload = response.get_json()
    assert response.status_code == 200
    assert payload["status"] == "ok"
    assert payload["guard"]["enabled"] is False
    assert appended and appended[0]["enabled_before"] is True
    assert appended[0]["enabled_after"] is False
    assert appended[0]["ok"] is True
