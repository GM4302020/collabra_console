# FILE: ~/otmega/otmega_app/console/admin_backend/tests/test_session.py
# ماموریت: تست رفتار session و کنترل دسترسی اولیه Admin Console.

from app import create_app


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
