# FILE: ~/otmega/otmega_app/console/admin_deploy/sync_ui_texts_from_db.py
# ماموریت: قبل از build، فایل‌های .py زبان‌ها را از روی config_domain_registry (منبع حقیقت) بازتولید می‌کند
#          تا fallback فایل‌ها همیشه با دیتابیس همسان باشند و بعد از redeploy «file keys» دروغ نگوید.
#
# منطق رندر دقیقاً مطابق console/admin_backend/admin_api/config_routes.py::_render_python_file است:
#   - en.py مرجع key set و ساختار کامنت/دسته‌بندی است (هرگز از DB بازنویسی نمی‌شود).
#   - هر زبان غیرانگلیسی: مقدارها از DB (payload.texts)، کلیدها = کلیدهای en، کلید بدون مقدار = خالی.
#   - اگر زبانی ردیف DB نداشته باشد، فقط key set فایلش با en همسان می‌شود (مقادیر موجود حفظ).
# رفتار tolerant: اگر DB در دسترس نباشد یا env ست نباشد، فایل‌های موجود دست‌نخورده می‌مانند و خروجی صفر است
# (deploy متوقف نمی‌شود).

import argparse
import ast
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

KEY_LINE = re.compile(r'^(\s*)"([^"]+)"\s*:\s*(.*?)(,?)\s*$')


def read_ui_texts(path: Path) -> dict:
    tree = ast.parse(path.read_text(encoding="utf-8-sig"), filename=str(path))
    for node in tree.body:
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id == "UI_TEXTS":
                    parsed = ast.literal_eval(node.value)
                    if isinstance(parsed, dict):
                        return {str(k): str(v) for k, v in parsed.items()}
    return {}


def render(language: str, values: dict, en_path: Path) -> str:
    out = []
    for line in en_path.read_text(encoding="utf-8-sig").splitlines():
        if line.startswith("# FILE: ") and "/ui_texts/en.py" in line:
            out.append(line.replace("/ui_texts/en.py", f"/ui_texts/{language}.py"))
            continue
        m = KEY_LINE.match(line)
        if not m:
            out.append(line)
            continue
        indent, key, _old, comma = m.groups()
        out.append(f"{indent}{json.dumps(key, ensure_ascii=False)}: {json.dumps(values.get(key, ''), ensure_ascii=False)}{comma or ','}")
    return "\n".join(out) + "\n"


def fetch_registry_texts(url: str, key: str) -> dict:
    query = urllib.parse.urlencode(
        {
            "select": "scope_ref,payload",
            # PostgREST الگوی like را با * می‌گیرد؛ % خام در URL نامعتبر است و 500 می‌دهد
            "domain_key": "like.ui_texts_*",
            "scope_kind": "eq.language",
            "is_active": "eq.true",
        },
        safe=",().*",
    )
    request = urllib.request.Request(
        f"{url.rstrip('/')}/rest/v1/config_domain_registry?{query}",
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Accept": "application/json",
            # UA پیش‌فرض Python-urllib توسط WAF کلادفلر روی db.otmega.com با 403 بلاک می‌شود
            "User-Agent": "otmega-ui-texts-sync/1.0",
        },
        method="GET",
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        rows = json.loads(response.read().decode("utf-8"))
    texts_by_language = {}
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict):
            continue
        language = str(row.get("scope_ref") or "").strip()
        payload = row.get("payload")
        texts = payload.get("texts") if isinstance(payload, dict) else None
        if language and isinstance(texts, dict):
            texts_by_language[language] = {str(k): str(v) for k, v in texts.items()}
    return texts_by_language


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ui-texts-dir", required=True)
    args = parser.parse_args()

    ui_texts_dir = Path(args.ui_texts_dir)
    en_path = ui_texts_dir / "en.py"
    if not en_path.exists():
        print(f"[ui-texts-sync] en.py not found at {en_path}; skipping.")
        return 0
    english_keys = list(read_ui_texts(en_path).keys())
    if not english_keys:
        print("[ui-texts-sync] en.py has no keys; skipping.")
        return 0

    url = os.environ.get("PRG2_SUPABASE_URL")
    service_key = os.environ.get("PRG2_SUPABASE_SERVICE_ROLE_KEY")
    if not url or not service_key:
        print("[ui-texts-sync] Supabase env not set; keeping existing .py files as-is.")
        return 0

    try:
        registry = fetch_registry_texts(url, service_key)
    except Exception as exc:  # noqa: BLE001 - deploy must not break on a transient DB issue
        print(f"[ui-texts-sync] WARNING: could not reach database ({exc}); keeping existing .py files.")
        return 0

    from_db = 0
    from_file = 0
    for path in sorted(ui_texts_dir.glob("*.py")):
        language = path.stem
        if path.name == "__init__.py" or language == "en":
            continue
        db_values = registry.get(language)
        if db_values:
            values = {key: db_values.get(key, "") for key in english_keys}
            from_db += 1
        else:
            existing = read_ui_texts(path)
            values = {key: existing.get(key, "") for key in english_keys}
            from_file += 1
        rendered = render(language, values, en_path)
        # اعتبارسنجی: خروجی باید Python معتبر باشد، وگرنه deploy باید متوقف شود (نه ship فایل خراب).
        try:
            ast.parse(rendered, filename=str(path))
        except SyntaxError as exc:
            print(f"[ui-texts-sync] ERROR: generated {path.name} is invalid Python ({exc}); aborting without writing.")
            return 1
        path.write_text(rendered, encoding="utf-8")

    print(
        f"[ui-texts-sync] Synced to {len(english_keys)} keys | "
        f"from_db={from_db} languages, key_set_only(no_db_row)={from_file} languages."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
