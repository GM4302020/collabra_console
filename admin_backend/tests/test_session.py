# FILE: ~/otmega/otmega_app/console/admin_backend/tests/test_session.py
# ماموریت: تست رفتار session، کنترل دسترسی و خواندن پروفایل واقعی Admin Console.

from app import create_app
from admin_api import profile_adapter


def test_session_without_token_is_guest_shell():
    app = create_app()
    client = app.test_client()

    response = client.get("/api/console/session")

    payload = response.get_json()
    assert response.status_code == 200
    assert payload["actor"]["authenticated"] is False
    assert payload["write_enabled"] is False
    assert payload["capabilities"] == ["console.view_health"]


def test_login_rejects_bad_credentials(monkeypatch):
    monkeypatch.setenv("FALLBACK_ADMIN_USER", "root@example.com")
    monkeypatch.setenv("FALLBACK_ADMIN_PASS", "correct-pass")
    app = create_app()
    app.config["TESTING"] = True
    client = app.test_client()

    response = client.post(
        "/api/console/login",
        json={"email": "root@example.com", "password": "wrong-pass"},
    )

    assert response.status_code == 401


def test_login_returns_user_zero_profile(monkeypatch):
    monkeypatch.setenv("FALLBACK_ADMIN_USER", "root@example.com")
    monkeypatch.setenv("FALLBACK_ADMIN_PASS", "correct-pass")
    monkeypatch.setenv("CONSOLE_ADMIN_FULL_NAME", "Console Root")
    monkeypatch.setenv("CONSOLE_ADMIN_TIER", "7")
    app = create_app()
    client = app.test_client()

    response = client.post(
        "/api/console/login",
        json={"email": "root@example.com", "password": "correct-pass"},
    )

    payload = response.get_json()
    assert response.status_code == 200
    assert payload["actor"]["authenticated"] is True
    assert payload["actor"]["full_name"] == "Console Root"
    assert payload["actor"]["access_level"] == "User Zero"
    assert payload["actor"]["tier"] == 7
    assert "console.view_trace_summary" in payload["capabilities"]


def test_runtime_inventory_requires_capability():
    app = create_app()
    client = app.test_client()

    response = client.get("/api/console/config/domains")

    assert response.status_code == 403


def test_operational_resources_requires_capability():
    app = create_app()
    client = app.test_client()

    response = client.get("/api/console/operations/resources")

    assert response.status_code == 403


def test_operational_resources_returns_inventory_for_user_zero(monkeypatch):
    monkeypatch.setenv("FALLBACK_ADMIN_USER", "root@example.com")
    monkeypatch.setenv("FALLBACK_ADMIN_PASS", "correct-pass")
    app = create_app()
    app.config["TESTING"] = True
    client = app.test_client()

    client.post("/api/console/login", json={"email": "root@example.com", "password": "correct-pass"})
    response = client.get("/api/console/operations/resources")

    payload = response.get_json()
    assert response.status_code == 200
    assert payload["write_enabled"] is False
    assert any(resource["id"] == "supabase-prg2" for resource in payload["resources"])


def test_avatar_candidates_follow_collabra_storage_contract():
    candidates = profile_adapter._avatar_path_candidates("assets/users/u1/user_pic_1.png")

    assert candidates[0] == "advisors/collabra-20018-v1.0.0/assets/users/u1/user_pic_1.webp"
    assert "assets/users/u1/user_pic_1.png" in candidates


def test_load_console_profile_filters_by_collabra_advisor(monkeypatch):
    seen_urls = []

    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def read(self):
            return (
                b'[{"user_id":"9197bacb-2387-4639-814f-9d643bbfb245",'
                b'"advisor_id":20018,'
                b'"email":"root@example.com",'
                b'"full_name":"System Root",'
                b'"role":"s_admin",'
                b'"tier":5,'
                b'"balance":"999999971.40",'
                b'"country_code":"us",'
                b'"avatar_path":"advisors/collabra-20018-v1.0.0/assets/users/u1/user_pic_1.webp",'
                b'"online_status":"online",'
                b'"last_typed_lang":"en"}]'
            )

    def fake_urlopen(request, timeout):
        seen_urls.append(request.full_url)
        return FakeResponse()

    monkeypatch.setenv("PRG2_SUPABASE_URL", "https://db.otmega.com")
    monkeypatch.setenv("PRG2_SUPABASE_SERVICE_ROLE_KEY", "service-role")
    monkeypatch.setattr(profile_adapter.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(profile_adapter, "_signed_avatar_url", lambda path: f"signed:{path}")

    profile = profile_adapter.load_console_profile("root@example.com", "9197bacb-2387-4639-814f-9d643bbfb245")

    assert "advisor_id=eq.20018" in seen_urls[0]
    assert profile["balance"] == "999999971.40"
    assert profile["avatar_url"].startswith("signed:advisors/collabra-20018-v1.0.0/")
    assert profile["profile_source"] == "profiles"
