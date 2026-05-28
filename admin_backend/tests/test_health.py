# FILE: ~/otmega/otmega_app/console/admin_backend/tests/test_health.py
# ماموریت: تست smoke برای routeهای health سرویس Admin Console.

from app import create_app


def test_public_health_returns_ok():
    app = create_app()
    client = app.test_client()

    response = client.get("/health")

    assert response.status_code == 200
    assert response.get_json()["status"] == "ok"


def test_console_health_is_read_only():
    app = create_app()
    client = app.test_client()

    response = client.get("/api/console/health")

    payload = response.get_json()
    assert response.status_code == 200
    assert payload["mode"] == "read_only"
    assert payload["write_enabled"] is False
