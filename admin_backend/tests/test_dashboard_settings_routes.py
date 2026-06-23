# FILE: ~/otmega/otmega_app/console/admin_backend/tests/test_dashboard_settings_routes.py
# ماموریت: تست ذخیره تنظیمات چیدمان Admin Console در فایل GCS.

import json

from app import create_app
from admin_api import dashboard_settings_routes


class FakeBlob:
    def __init__(self):
        self.content = None
        self.content_type = None

    def exists(self):
        return self.content is not None

    def download_as_text(self, encoding="utf-8"):
        return self.content

    def upload_from_string(self, content, content_type=None):
        self.content = content
        self.content_type = content_type


class FakeBucket:
    def __init__(self, blob):
        self._blob = blob
        self.seen_names = []

    def blob(self, name):
        self.seen_names.append(name)
        return self._blob


class FakeStorageClient:
    def __init__(self, bucket):
        self._bucket = bucket

    def bucket(self, name):
        assert name == "otmega-collabra-secure"
        return self._bucket


def test_dashboard_settings_round_trip_to_gcs(monkeypatch):
    monkeypatch.setenv("FALLBACK_ADMIN_USER", "root@example.com")
    monkeypatch.setenv("FALLBACK_ADMIN_PASS", "correct-pass")

    fake_blob = FakeBlob()
    fake_bucket = FakeBucket(fake_blob)
    monkeypatch.setattr(dashboard_settings_routes, "_storage_client", FakeStorageClient(fake_bucket))

    app = create_app()
    app.config["TESTING"] = True
    client = app.test_client()
    client.post("/api/console/login", json={"email": "root@example.com", "password": "correct-pass"})

    initial = client.get("/api/console/dashboard-settings")
    assert initial.status_code == 200
    assert initial.get_json()["settings"] == {}

    saved = client.post(
        "/api/console/dashboard-settings",
        json={"section": "user_operations", "value": {"pageSize": 50, "hiddenColumns": ["online"]}},
    )
    payload = saved.get_json()

    assert saved.status_code == 200
    assert payload["path"] == dashboard_settings_routes.SETTINGS_BLOB
    assert payload["settings"]["user_operations"]["pageSize"] == 50
    assert fake_bucket.seen_names[-1] == dashboard_settings_routes.SETTINGS_BLOB

    document = json.loads(fake_blob.content)
    actor_entry = document["actors"]["root@example.com"]
    assert actor_entry["settings"]["user_operations"]["hiddenColumns"] == ["online"]
    assert document["updated_by"] == "root@example.com"


def test_dashboard_settings_rejects_invalid_section(monkeypatch):
    monkeypatch.setenv("FALLBACK_ADMIN_USER", "root@example.com")
    monkeypatch.setenv("FALLBACK_ADMIN_PASS", "correct-pass")
    monkeypatch.setattr(dashboard_settings_routes, "_storage_client", FakeStorageClient(FakeBucket(FakeBlob())))

    app = create_app()
    app.config["TESTING"] = True
    client = app.test_client()
    client.post("/api/console/login", json={"email": "root@example.com", "password": "correct-pass"})

    response = client.post("/api/console/dashboard-settings", json={"section": "../bad", "value": {}})

    assert response.status_code == 400
