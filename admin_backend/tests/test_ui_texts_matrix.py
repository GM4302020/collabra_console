# FILE: ~/otmega/otmega_app/console/admin_backend/tests/test_ui_texts_matrix.py
# ماموریت: تست APIهای read-only ماتریس UI Texts و تولید patch دستی.

from app import create_app
from admin_api import config_routes


def _login_user_zero(client, monkeypatch):
    monkeypatch.setenv("FALLBACK_ADMIN_USER", "root@example.com")
    monkeypatch.setenv("FALLBACK_ADMIN_PASS", "correct-pass")
    return client.post(
        "/api/console/login",
        json={"email": "root@example.com", "password": "correct-pass"},
    )


def test_ui_texts_matrix_requires_capability():
    app = create_app()
    client = app.test_client()

    response = client.get("/api/console/ui-texts/matrix")

    assert response.status_code == 403


def test_ui_texts_matrix_returns_languages_for_user_zero(monkeypatch):
    app = create_app()
    client = app.test_client()
    _login_user_zero(client, monkeypatch)
    monkeypatch.setattr(config_routes, "_fetch_ui_texts_registry_payloads", lambda: ({}, {}))

    response = client.get("/api/console/ui-texts/matrix")

    payload = response.get_json()
    assert response.status_code == 200
    assert payload["matrix"]["languages"][0] == "en"
    assert payload["matrix"]["write_enabled"] is False
    assert response.headers["Cache-Control"] == "no-store, max-age=0"
    assert any(row["key"] == "UI_TEXTS_RUNTIME_TITLE" for row in payload["matrix"]["rows"])


def test_ui_texts_patch_generates_manual_outputs(monkeypatch):
    app = create_app()
    client = app.test_client()
    _login_user_zero(client, monkeypatch)

    response = client.post(
        "/api/console/ui-texts/patch",
        json={
            "changes": {"en": {"TEST_CONSOLE_KEY": "Console test value"}},
            "matrix": {"en": {"TEST_CONSOLE_KEY": "Console test value"}},
            "ordered_keys": ["TEST_CONSOLE_KEY"],
        },
    )

    payload = response.get_json()
    assert response.status_code == 200
    assert payload["write_enabled"] is False
    assert "ui_texts_en" in payload["sql_patch"]
    assert "jsonb_object_keys(payload->'texts')" in payload["sql_patch"]
    assert payload["python_files"][0]["filename"] == "en.py"
    assert "TEST_CONSOLE_KEY" in payload["python_files"][0]["content"]


def test_ui_texts_patch_exports_python_files_without_changes(monkeypatch):
    app = create_app()
    client = app.test_client()
    _login_user_zero(client, monkeypatch)

    response = client.post(
        "/api/console/ui-texts/patch",
        json={
            "changes": {},
            "export_languages": ["fa"],
            "matrix": {"fa": {"MAIN_TITLE": "اصلی"}},
            "ordered_keys": ["MAIN_TITLE"],
        },
    )

    payload = response.get_json()
    assert response.status_code == 200
    assert payload["changed_key_count"] == 0
    assert payload["python_files"][0]["filename"] == "fa.py"
    assert "/ui_texts/fa.py" in payload["python_files"][0]["content"]


def test_render_python_file_preserves_english_template_comments(monkeypatch, tmp_path):
    template_dir = tmp_path / "ui_texts"
    template_dir.mkdir()
    (template_dir / "en.py").write_text(
        "# FILE: ~/otmega/otmega_app/backend/advisor/settings/ui_texts/en.py\n"
        "# Mission\n"
        "\n"
        "UI_TEXTS = {\n"
        "    # ==============================================\n"
        "    # === 11. Media Viewer and Account Blocks ===\n"
        "    # ==============================================\n"
        "    \"MAIN_TITLE\": \"Main\",\n"
        "\n"
        "    # --- Console Added Keys ---\n"
        "    \"SECOND_KEY\": \"Second\",\n"
        "}\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(config_routes, "UI_TEXTS_DIR", template_dir)

    content = config_routes._render_python_file(
        "fa",
        {"MAIN_TITLE": "اصلی", "SECOND_KEY": "دوم"},
        ["MAIN_TITLE", "SECOND_KEY"],
    )

    assert "# === 11. Media Viewer and Account Blocks ===" in content
    assert "\n\n    # --- Console Added Keys ---" in content
    assert '"MAIN_TITLE": "اصلی",' in content
    assert '"SECOND_KEY": "دوم",' in content
    assert "/ui_texts/fa.py" in content


def test_ui_texts_llm_options_requires_user_zero_capability():
    app = create_app()
    client = app.test_client()

    response = client.get("/api/console/ui-texts/llm-options")

    assert response.status_code == 403


def test_ui_texts_llm_options_returns_selector_choices(monkeypatch):
    app = create_app()
    client = app.test_client()
    _login_user_zero(client, monkeypatch)
    monkeypatch.setenv("GEMINI_API_KEY_25", "test-key")
    monkeypatch.setattr(config_routes, "_fetch_wf1_llm_payload", lambda: None)

    response = client.get("/api/console/ui-texts/llm-options")

    payload = response.get_json()
    assert response.status_code == 200
    assert payload["source"] == "fallback"
    assert any(option["key"] == "gemini_25_flash_lite" for option in payload["options"])


def test_ui_texts_ai_suggestions_apply_provider_response(monkeypatch):
    app = create_app()
    client = app.test_client()
    _login_user_zero(client, monkeypatch)
    monkeypatch.setenv("GEMINI_API_KEY_25", "test-key")
    monkeypatch.setattr(config_routes, "_fetch_wf1_llm_payload", lambda: None)
    monkeypatch.setattr(
        config_routes,
        "_call_ui_texts_llm",
        lambda _option, _prompt: '{"translations":[{"key":"HELLO","language":"fa","text":"سلام"}]}',
    )

    response = client.post(
        "/api/console/ui-texts/ai-suggestions",
        json={
            "model_option_key": "gemini_25_flash_lite",
            "cells": [{"key": "HELLO", "language": "fa", "english_text": "Hello", "current_text": ""}],
        },
    )

    payload = response.get_json()
    assert response.status_code == 200
    assert payload["requested_count"] == 1
    assert payload["suggested_count"] == 1
    assert payload["suggestions"][0]["text"] == "سلام"


def test_ui_texts_matrix_can_load_packaged_language_assets(monkeypatch, tmp_path):
    packaged_dir = tmp_path / "assets" / "ui_texts"
    packaged_dir.mkdir(parents=True)
    (packaged_dir / "en.py").write_text(
        '# === 1. Packaged Category ===\nUI_TEXTS = {\n    "PACKAGED_TEST_KEY": "Packaged value",\n}\n',
        encoding="utf-8",
    )
    (packaged_dir / "fa.py").write_text('UI_TEXTS = {"PACKAGED_TEST_KEY": "مقدار بسته"}\n', encoding="utf-8")
    monkeypatch.setattr(config_routes, "UI_TEXTS_DIR", packaged_dir)

    matrix = config_routes._load_ui_texts_matrix()

    assert matrix["languages"] == ["en", "fa"]
    assert matrix["rows"][0]["key"] == "PACKAGED_TEST_KEY"
    assert matrix["rows"][0]["category"] == "Packaged Category"
    assert matrix["rows"][0]["values"]["fa"] == "مقدار بسته"


def test_ui_texts_matrix_prefers_runtime_registry_payload(monkeypatch, tmp_path):
    packaged_dir = tmp_path / "assets" / "ui_texts"
    packaged_dir.mkdir(parents=True)
    (packaged_dir / "en.py").write_text(
        'UI_TEXTS = {"MAIN_TITLE": "File main", "FILE_ONLY_KEY": "File only"}\n',
        encoding="utf-8",
    )
    monkeypatch.setattr(config_routes, "UI_TEXTS_DIR", packaged_dir)
    monkeypatch.setattr(
        config_routes,
        "_fetch_ui_texts_registry_payloads",
        lambda: (
            {"en": {"MAIN_TITLE": "DB main"}, "fa": {"MAIN_TITLE": "DB اصلی"}},
            {
                "en": {"source": "config_domain_registry", "updated_at": "2026-06-04T00:00:00Z"},
                "fa": {"source": "config_domain_registry", "updated_at": "2026-06-04T00:00:01Z"},
            },
        ),
    )

    matrix = config_routes._load_ui_texts_matrix()

    assert matrix["source"] == "config_domain_registry"
    assert matrix["languages"] == ["en", "fa"]
    assert matrix["rows"][0]["values"]["en"] == "DB main"
    assert any(row["key"] == "FILE_ONLY_KEY" and row["values"]["en"] == "File only" for row in matrix["rows"])
    assert matrix["language_summaries"][0]["runtime_source"] == "config_domain_registry"
    assert matrix["language_summaries"][0]["runtime_key_count"] == 1
    assert matrix["language_summaries"][0]["fallback_key_count"] == 2
