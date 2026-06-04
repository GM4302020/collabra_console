# FILE: ~/otmega/otmega_app/console/admin_backend/admin_api/config_routes.py
# ماموریت: API مشاهده read-only تنظیمات runtime، configها و ابزارهای خروجی امن UI Texts.

import ast
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from flask import Blueprint, jsonify, request
from admin_api.guards import require_capability

config_bp = Blueprint("console_config", __name__)

ADMIN_BACKEND_ROOT = Path(__file__).resolve().parents[1]
PACKAGED_UI_TEXTS_DIR = ADMIN_BACKEND_ROOT / "assets" / "ui_texts"
REPO_UI_TEXTS_DIR = ADMIN_BACKEND_ROOT.parent.parent / "backend" / "advisor" / "settings" / "ui_texts"
UI_TEXTS_DIR = Path(os.environ.get("CONSOLE_UI_TEXTS_DIR") or (REPO_UI_TEXTS_DIR if REPO_UI_TEXTS_DIR.exists() else PACKAGED_UI_TEXTS_DIR))
UI_TEXT_KEY_LINE = re.compile(r'^\s*"([^"]+)"\s*:')
ADVISOR_ID = os.environ.get("CONSOLE_ADVISOR_ID", "20018")
WF1_LLM_FALLBACK_OPTIONS = [
    {
        "key": "gemini_25_flash_lite",
        "label": "Gemini 2.5 Flash Lite",
        "provider": "google",
        "product": "gemini-2.5-flash-lite",
        "model": "gemini-2.5-flash-lite",
        "api_key_env": "GEMINI_API_KEY_25",
        "transport": "google_generative_language_api",
        "enabled": True,
    },
    {
        "key": "gpt_4o",
        "label": "GPT-4o",
        "provider": "openai",
        "product": "gpt-4o",
        "model": "gpt-4o",
        "api_key_env": "OPENAI_API_KEY",
        "transport": "openai_chat_completions",
        "enabled": True,
    },
    {
        "key": "gpt_4o_mini",
        "label": "GPT-4o mini",
        "provider": "openai",
        "product": "gpt-4o-mini",
        "model": "gpt-4o-mini",
        "api_key_env": "OPENAI_API_KEY",
        "transport": "openai_chat_completions",
        "enabled": True,
    },
    {
        "key": "openrouter_test_slot",
        "label": "OpenRouter Test Slot",
        "provider": "openrouter",
        "product": "openrouter-test-slot",
        "model": "x-ai/grok-4.20-beta",
        "api_key_env": "OPENROUTER_API_KEY",
        "transport": "openai_compatible_api",
        "enabled": True,
    },
]


def _read_ui_texts_file(path: Path) -> dict[str, str]:
    tree = ast.parse(path.read_text(encoding="utf-8-sig"), filename=str(path))
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        for target in node.targets:
            if isinstance(target, ast.Name) and target.id == "UI_TEXTS":
                parsed = ast.literal_eval(node.value)
                if isinstance(parsed, dict):
                    return {str(key): str(value) for key, value in parsed.items()}
    return {}


def _clean_comment_heading(line: str, marker: str) -> str:
    text = line.strip().lstrip("#").strip()
    text = text.strip(marker).strip()
    return re.sub(r"^\d+\.\s*", "", text).strip()


def _read_ui_texts_categories(path: Path) -> dict[str, dict[str, str]]:
    if not path.exists():
        return {}
    categories: dict[str, dict[str, str]] = {}
    current_category = "Uncategorized"
    current_subcategory = ""
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        stripped = line.strip()
        if stripped.startswith("# ===") and stripped.endswith("==="):
            heading = _clean_comment_heading(stripped, "=")
            if heading:
                current_category = heading
                current_subcategory = ""
            continue
        if stripped.startswith("# ---") and stripped.endswith("---"):
            current_subcategory = _clean_comment_heading(stripped, "-")
            continue
        match = UI_TEXT_KEY_LINE.match(line)
        if match:
            categories[match.group(1)] = {
                "category": current_category,
                "subcategory": current_subcategory,
            }
    return categories


def _fetch_ui_texts_registry_payloads() -> tuple[dict[str, dict[str, str]], dict[str, dict]]:
    supabase_url = (os.environ.get("PRG2_SUPABASE_URL") or "").rstrip("/")
    headers = _rest_headers()
    if not supabase_url or not headers:
        return {}, {}
    query = urllib.parse.urlencode(
        {
            "select": "domain_key,scope_ref,payload,updated_at",
            "domain_key": "like.ui_texts_%",
            "scope_kind": "eq.language",
            "is_active": "eq.true",
        },
        safe=",().*",
    )
    registry_request = urllib.request.Request(
        f"{supabase_url}/rest/v1/config_domain_registry?{query}",
        headers=headers,
        method="GET",
    )
    try:
        with urllib.request.urlopen(registry_request, timeout=10) as response:
            rows = json.loads(response.read().decode("utf-8"))
    except Exception:
        return {}, {}

    texts_by_language: dict[str, dict[str, str]] = {}
    metadata_by_language: dict[str, dict] = {}
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict):
            continue
        language = str(row.get("scope_ref") or "").strip()
        payload = row.get("payload")
        texts = payload.get("texts") if isinstance(payload, dict) else None
        if not language or not isinstance(texts, dict):
            continue
        texts_by_language[language] = {str(key): str(value) for key, value in texts.items()}
        metadata_by_language[language] = {
            "domain_key": row.get("domain_key"),
            "updated_at": row.get("updated_at"),
            "source": "config_domain_registry",
        }
    return texts_by_language, metadata_by_language


def _load_ui_texts_matrix():
    file_language_files = sorted(
        path for path in UI_TEXTS_DIR.glob("*.py")
        if path.name != "__init__.py"
    )
    file_languages = [path.stem for path in file_language_files]
    file_texts_by_language: dict[str, dict[str, str]] = {}
    for language in file_languages:
        file_texts_by_language[language] = _read_ui_texts_file(UI_TEXTS_DIR / f"{language}.py")

    registry_texts_by_language, registry_metadata_by_language = _fetch_ui_texts_registry_payloads()
    texts_by_language = {
        language: {
            **file_texts_by_language.get(language, {}),
            **registry_texts_by_language.get(language, {}),
        }
        for language in dict.fromkeys([*file_languages, *registry_texts_by_language.keys()])
    }
    languages = list(dict.fromkeys(["en", *file_languages, *registry_texts_by_language.keys()]))
    languages = [language for language in languages if language in texts_by_language or language in file_texts_by_language]
    if "en" in languages:
        languages.remove("en")
        languages.insert(0, "en")

    for language in languages:
        if language not in texts_by_language:
            texts_by_language[language] = file_texts_by_language.get(language, {})

    english_keys = list(file_texts_by_language.get("en", {}).keys())
    if not english_keys:
        english_keys = list(texts_by_language.get("en", {}).keys())
    english_categories = _read_ui_texts_categories(UI_TEXTS_DIR / "en.py")
    all_keys = list(english_keys)
    seen = set(all_keys)
    for language in languages:
        for key in texts_by_language.get(language, {}):
            if key not in seen:
                seen.add(key)
                all_keys.append(key)

    rows = []
    for key in all_keys:
        values = {
            language: texts_by_language.get(language, {}).get(key, "")
            for language in languages
        }
        missing_languages = [language for language, value in values.items() if not value]
        rows.append({
            "key": key,
            "category": english_categories.get(key, {}).get("category", "Uncategorized"),
            "subcategory": english_categories.get(key, {}).get("subcategory", ""),
            "values": values,
            "missing_languages": missing_languages,
            "orphan": key not in texts_by_language.get("en", {}),
        })

    language_summaries = []
    english_key_set = set(texts_by_language.get("en", {}))
    for language in languages:
        key_set = set(texts_by_language.get(language, {}))
        registry_metadata = registry_metadata_by_language.get(language, {})
        runtime_key_count = len(registry_texts_by_language.get(language, {})) if registry_texts_by_language else None
        fallback_key_count = len(file_texts_by_language.get(language, {}))
        language_summaries.append({
            "code": language,
            "key_count": len(key_set),
            "runtime_key_count": runtime_key_count,
            "fallback_key_count": fallback_key_count,
            "missing_from_english": sorted(key_set - english_key_set),
            "missing_from_language": sorted(english_key_set - key_set),
            "source_file": str(UI_TEXTS_DIR / f"{language}.py"),
            "runtime_source": registry_metadata.get("source") or "python_file_fallback",
            "runtime_updated_at": registry_metadata.get("updated_at"),
        })

    return {
        "languages": languages,
        "rows": rows,
        "language_summaries": language_summaries,
        "source": "config_domain_registry" if registry_texts_by_language else "backend_ui_texts_py_files",
        "write_enabled": False,
        "gcs_enabled": False,
        "ai_suggestions_enabled": False,
    }


def _safe_sql_literal(value: str) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def _rest_headers() -> dict[str, str] | None:
    service_role_key = os.environ.get("PRG2_SUPABASE_SERVICE_ROLE_KEY")
    if not service_role_key:
        return None
    return {
        "Accept": "application/json",
        "apikey": service_role_key,
        "Authorization": f"Bearer {service_role_key}",
    }


def _fetch_wf1_llm_payload() -> dict | None:
    supabase_url = (os.environ.get("PRG2_SUPABASE_URL") or "").rstrip("/")
    headers = _rest_headers()
    if not supabase_url or not headers:
        return None
    query = urllib.parse.urlencode(
        {
            "select": "payload,version",
            "domain_key": "eq.wf1_translation_llm",
            "scope_kind": "eq.advisor",
            "scope_ref": f"eq.{ADVISOR_ID}",
            "is_active": "eq.true",
            "order": "version.desc",
            "limit": "1",
        },
        safe=",().",
    )
    request = urllib.request.Request(f"{supabase_url}/rest/v1/config_domain_registry?{query}", headers=headers, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            rows = json.loads(response.read().decode("utf-8"))
    except Exception:
        return None
    row = rows[0] if isinstance(rows, list) and rows and isinstance(rows[0], dict) else None
    payload = row.get("payload") if row else None
    return payload if isinstance(payload, dict) else None


def _normalize_llm_option(option: dict) -> dict | None:
    if not isinstance(option, dict):
        return None
    option_key = str(option.get("key") or "").strip()
    model = str(option.get("model") or "").strip()
    provider = str(option.get("provider") or "").strip().lower()
    api_key_env = str(option.get("api_key_env") or option.get("apiKeyEnv") or "").strip()
    if not option_key or not model or not provider or not api_key_env:
        return None
    return {
        "key": option_key,
        "label": str(option.get("label") or option_key),
        "provider": provider,
        "product": str(option.get("product") or model),
        "model": model,
        "api_key_env": api_key_env,
        "transport": str(option.get("transport") or ""),
        "enabled": bool(option.get("enabled", True)),
        "secret_available": bool(os.environ.get(api_key_env)),
    }


def _load_wf1_llm_options() -> dict:
    payload = _fetch_wf1_llm_payload()
    source = "config_domain_registry" if payload else "fallback"
    raw_options = payload.get("model_options") if isinstance(payload, dict) else WF1_LLM_FALLBACK_OPTIONS
    options = []
    for option in raw_options if isinstance(raw_options, list) else []:
        normalized = _normalize_llm_option(option)
        if normalized and normalized.get("enabled", True):
            options.append(normalized)
    active_key = str(payload.get("active_option_key") or "") if isinstance(payload, dict) else "gemini_25_flash_lite"
    if active_key not in {option["key"] for option in options} and options:
        active_key = options[0]["key"]
    return {"options": options, "active_option_key": active_key, "source": source}


def _llm_option_by_key(option_key: str) -> dict | None:
    options_payload = _load_wf1_llm_options()
    return next((option for option in options_payload["options"] if option["key"] == option_key), None)


def _build_ui_texts_translation_prompt(cells: list[dict]) -> str:
    compact_cells = [
        {
            "key": cell["key"],
            "language": cell["language"],
            "english_text": cell["english_text"],
            "current_text": cell.get("current_text") or "",
        }
        for cell in cells
    ]
    return (
        "You are translating fixed UI strings for an application.\n"
        "Translate from English into the requested target language for each item.\n"
        "Preserve placeholders like {count}, {name}, HTML-like tokens, punctuation intent, and product names.\n"
        "Return only strict JSON with this exact shape: "
        '{"translations":[{"key":"...","language":"...","text":"..."}]}.\n'
        "Do not add explanations.\n"
        f"Items:\n{json.dumps(compact_cells, ensure_ascii=False)}"
    )


def _extract_response_text(payload: dict) -> str:
    choices = payload.get("choices")
    if isinstance(choices, list) and choices:
        message = choices[0].get("message") if isinstance(choices[0], dict) else None
        content = message.get("content") if isinstance(message, dict) else None
        if isinstance(content, str):
            return content
    candidates = payload.get("candidates")
    if isinstance(candidates, list) and candidates:
        content = candidates[0].get("content") if isinstance(candidates[0], dict) else None
        parts = content.get("parts") if isinstance(content, dict) else None
        if isinstance(parts, list):
            return "".join(part.get("text", "") for part in parts if isinstance(part, dict))
    return ""


def _post_json(url: str, headers: dict[str, str], payload: dict, timeout: int = 45) -> dict:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(url, data=data, headers={**headers, "Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"LLM provider returned {exc.code}: {body[:300]}") from exc


def _call_ui_texts_llm(option: dict, prompt: str) -> str:
    api_key = os.environ.get(option["api_key_env"])
    if not api_key:
        raise RuntimeError(f"Missing API key env: {option['api_key_env']}")
    provider = option["provider"]
    model = option["model"]
    if provider == "google":
        payload = _post_json(
            f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={urllib.parse.quote(api_key)}",
            {},
            {
                "contents": [{"parts": [{"text": prompt}]}],
                "generationConfig": {"temperature": 0.1, "responseMimeType": "application/json"},
            },
        )
        return _extract_response_text(payload)
    url = "https://api.openai.com/v1/chat/completions" if provider == "openai" else "https://openrouter.ai/api/v1/chat/completions"
    payload = _post_json(
        url,
        {"Authorization": f"Bearer {api_key}"},
        {
            "model": model,
            "temperature": 0.1,
            "response_format": {"type": "json_object"},
            "messages": [{"role": "user", "content": prompt}],
        },
    )
    return _extract_response_text(payload)


def _parse_translation_response(response_text: str, requested_cells: list[dict]) -> list[dict]:
    parsed = json.loads(response_text)
    translations = parsed.get("translations") if isinstance(parsed, dict) else None
    requested = {(cell["key"], cell["language"]) for cell in requested_cells}
    results = []
    for item in translations if isinstance(translations, list) else []:
        if not isinstance(item, dict):
            continue
        key = str(item.get("key") or "")
        language = str(item.get("language") or "")
        text = str(item.get("text") or "").strip()
        if (key, language) in requested and text:
            results.append({"key": key, "language": language, "text": text})
    return results


def _render_python_file(language: str, values: dict[str, str], ordered_keys: list[str]) -> str:
    template_path = UI_TEXTS_DIR / "en.py"
    template_lines = template_path.read_text(encoding="utf-8-sig").splitlines() if template_path.exists() else []
    rendered_lines = []
    rendered_keys = set()
    key_line_pattern = re.compile(r'^(\s*)"([^"]+)"\s*:\s*(.*?)(,?)\s*$')

    for line in template_lines:
        if line.startswith("# FILE: ") and "/ui_texts/en.py" in line:
            rendered_lines.append(line.replace("/ui_texts/en.py", f"/ui_texts/{language}.py"))
            continue

        match = key_line_pattern.match(line)
        if not match:
            rendered_lines.append(line)
            continue

        indent, key, _old_value, comma = match.groups()
        value = values.get(key, "")
        rendered_lines.append(f"{indent}{json.dumps(key, ensure_ascii=False)}: {json.dumps(value, ensure_ascii=False)}{comma or ','}")
        rendered_keys.add(key)

    extra_keys = [key for key in ordered_keys if key not in rendered_keys and key in values]
    if extra_keys:
        insert_at = next((index for index in range(len(rendered_lines) - 1, -1, -1) if rendered_lines[index].strip() == "}"), len(rendered_lines))
        extra_lines = [
            "",
            "    # --- Console Added Keys ---",
            *[
                f"    {json.dumps(key, ensure_ascii=False)}: {json.dumps(values.get(key, ''), ensure_ascii=False)},"
                for key in extra_keys
            ],
        ]
        rendered_lines[insert_at:insert_at] = extra_lines

    if not rendered_lines:
        rendered_lines = [
            f"# FILE: ~/otmega/otmega_app/backend/advisor/settings/ui_texts/{language}.py",
            "# Mission: UI text fallback values for application i18n.",
            "",
            "UI_TEXTS = {",
            *[
                f"    {json.dumps(key, ensure_ascii=False)}: {json.dumps(values.get(key, ''), ensure_ascii=False)},"
                for key in ordered_keys
                if key in values
            ],
            "}",
        ]

    return "\n".join(rendered_lines) + "\n"


def _build_sql_patch(changes: dict[str, dict[str, str]]) -> str:
    lines = [
        "-- Generated by Admin Console UI Texts Matrix.",
        "-- Review manually before execution. Phase 1 does not write to the database directly.",
        "begin;",
        "",
    ]
    for language, language_changes in sorted(changes.items()):
        domain_key = f"ui_texts_{language}"
        for key, value in sorted(language_changes.items()):
            lines.extend([
                "update public.config_domain_registry",
                "set",
                "  payload = jsonb_set(",
                "    payload,",
                f"    array['texts', {_safe_sql_literal(key)}],",
                f"    to_jsonb({_safe_sql_literal(value)}::text),",
                "    true",
                "  ),",
                "  updated_at = now()",
                f"where domain_key = {_safe_sql_literal(domain_key)}",
                "  and scope_kind = 'language'",
                f"  and scope_ref = {_safe_sql_literal(language)}",
                "  and is_active = true",
                "  and payload ? 'texts';",
                "",
            ])
    lines.extend([
        "commit;",
        "",
        "select",
        "  domain_key,",
        "  scope_ref as language_code,",
        "  (select count(*) from jsonb_object_keys(payload->'texts')) as text_key_count,",
        "  updated_at",
        "from public.config_domain_registry",
        "where domain_key like 'ui_texts_%'",
        "  and scope_kind = 'language'",
        "  and is_active = true",
        "order by domain_key;",
        "",
    ])
    return "\n".join(lines)


@config_bp.get("/api/console/config/domains")
@require_capability("console.view_runtime_inventory")
def config_domains():
    return jsonify(
        {
            "status": "ok",
            "mode": "read_only",
            "domains": [
                {"key": "wf1_translation_llm", "source": "config_domain_registry", "write_enabled": False},
                {"key": "zone_visibility_controls", "source": "config_domain_registry", "write_enabled": False},
                {"key": "frontend_version_controls", "source": "config_domain_registry", "write_enabled": False},
                {"key": "guest_banner_controls", "source": "config_domain_registry", "write_enabled": False},
                {"key": "ui_texts_runtime_controls", "source": "config_domain_registry", "write_enabled": False},
                {"key": "ui_texts_matrix", "source": "backend_ui_texts_py_files", "write_enabled": False},
            ],
        }
    )


@config_bp.get("/api/console/ui-texts/matrix")
@require_capability("console.view_ui_texts_matrix")
def ui_texts_matrix():
    response = jsonify({"status": "ok", "matrix": _load_ui_texts_matrix()})
    response.headers["Cache-Control"] = "no-store, max-age=0"
    return response


@config_bp.get("/api/console/ui-texts/llm-options")
@require_capability("console.use_ui_texts_ai_suggestions")
def ui_texts_llm_options():
    options_payload = _load_wf1_llm_options()
    return jsonify({"status": "ok", **options_payload})


@config_bp.post("/api/console/ui-texts/ai-suggestions")
@require_capability("console.use_ui_texts_ai_suggestions")
def ui_texts_ai_suggestions():
    from flask import request

    payload = request.get_json(silent=True) or {}
    option_key = str(payload.get("model_option_key") or "").strip()
    cells_payload = payload.get("cells")
    if not option_key:
        return jsonify({"status": "error", "message": "model_option_key is required."}), 400
    if not isinstance(cells_payload, list) or not cells_payload:
        return jsonify({"status": "error", "message": "At least one cell is required."}), 400
    if len(cells_payload) > 200:
        return jsonify({"status": "error", "message": "At most 200 cells can be translated per request."}), 400

    option = _llm_option_by_key(option_key)
    if option is None:
        return jsonify({"status": "error", "message": "Requested LLM option is not available."}), 400

    cells = []
    seen = set()
    for raw_cell in cells_payload:
        if not isinstance(raw_cell, dict):
            continue
        key = str(raw_cell.get("key") or "").strip()
        language = str(raw_cell.get("language") or "").strip()
        english_text = str(raw_cell.get("english_text") or "").strip()
        current_text = str(raw_cell.get("current_text") or "").strip()
        if not key or not language or language == "en" or not english_text:
            continue
        cell_id = (key, language)
        if cell_id in seen:
            continue
        seen.add(cell_id)
        cells.append({
            "key": key,
            "language": language,
            "english_text": english_text,
            "current_text": current_text,
        })

    if not cells:
        return jsonify({"status": "error", "message": "No translatable cells were provided."}), 400

    prompt = _build_ui_texts_translation_prompt(cells)
    try:
        response_text = _call_ui_texts_llm(option, prompt)
        suggestions = _parse_translation_response(response_text, cells)
    except Exception as exc:
        return jsonify({"status": "error", "message": str(exc)}), 502

    return jsonify({
        "status": "ok",
        "model_option_key": option_key,
        "provider": option["provider"],
        "model": option["model"],
        "requested_count": len(cells),
        "suggested_count": len(suggestions),
        "suggestions": suggestions,
    })


@config_bp.post("/api/console/ui-texts/patch")
@require_capability("console.view_ui_texts_matrix")
def ui_texts_patch():
    from flask import request

    payload = request.get_json(silent=True) or {}
    changes = payload.get("changes") if isinstance(payload, dict) else {}
    matrix = payload.get("matrix") if isinstance(payload, dict) else {}
    ordered_keys = payload.get("ordered_keys") if isinstance(payload, dict) else []
    export_languages = payload.get("export_languages") if isinstance(payload, dict) else []
    if not isinstance(export_languages, list):
        export_languages = []

    safe_changes = {
        str(language): {
            str(key): str(value)
            for key, value in language_changes.items()
            if isinstance(language_changes, dict)
        }
        for language, language_changes in (changes or {}).items()
        if isinstance(language_changes, dict)
    }
    safe_matrix = {
        str(language): {
            str(key): str(value)
            for key, value in language_values.items()
            if isinstance(language_values, dict)
        }
        for language, language_values in (matrix or {}).items()
        if isinstance(language_values, dict)
    }
    safe_ordered_keys = [str(key) for key in ordered_keys if isinstance(key, str)]
    if not safe_ordered_keys:
        safe_ordered_keys = sorted({key for values in safe_matrix.values() for key in values})
    safe_export_languages = [
        str(language)
        for language in export_languages
        if isinstance(language, str) and str(language) in safe_matrix
    ]
    python_languages = sorted(set(safe_changes) | set(safe_export_languages))

    python_files = [
        {
            "language": language,
            "filename": f"{language}.py",
            "content": _render_python_file(language, safe_matrix.get(language, {}), safe_ordered_keys),
        }
        for language in python_languages
        if language in safe_matrix
    ]

    return jsonify({
        "status": "ok",
        "write_enabled": False,
        "sql_patch": _build_sql_patch(safe_changes),
        "python_files": python_files,
        "changed_language_count": len(safe_changes),
        "changed_key_count": sum(len(values) for values in safe_changes.values()),
    })
