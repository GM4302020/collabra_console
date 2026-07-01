# FILE: ~/otmega/otmega_app/console/admin_backend/admin_api/supabase_monitor_routes.py
# ماموریت: endpointهای read-only برای مانیتورینگ Supabase و audit پیام‌های LIP/WF1 در Admin Console.

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

from flask import Blueprint, jsonify, request

from admin_api.guards import require_capability

supabase_monitor_bp = Blueprint("console_supabase_monitor", __name__)

ADVISOR_ID = int(os.environ.get("CONSOLE_ADVISOR_ID") or os.environ.get("COLLABRA_ADVISOR_ID") or "20018")
STATUS_API_URL = "https://status.supabase.com/api/v2/summary.json"

IMPORTANT_TABLES = [
    {"name": "advisors", "select": "id", "notes": "Tenant/project root"},
    {"name": "profiles", "select": "user_id", "advisor_filter": True, "notes": "User profile and language state"},
    {"name": "conversations", "select": "id", "advisor_filter": True, "notes": "Chat room header"},
    {"name": "conversation_participants", "select": "conversation_id", "notes": "Chat membership and unread counters"},
    {"name": "messages", "select": "id", "advisor_filter": True, "notes": "Message, LIP/WF1 and media metadata"},
    {"name": "message_notify_dedupe", "select": "message_id", "advisor_filter": True, "notes": "Notification dedupe state"},
    {"name": "config_domain_registry", "select": "domain_key", "notes": "Runtime config registry"},
    {"name": "profile_visibility_settings", "select": "user_id", "advisor_filter": True, "notes": "Visibility and banner relation rules"},
    {"name": "invitations", "select": "id", "advisor_filter": True, "notes": "Invite state"},
]

DOCUMENTED_INDEXES = {
    "config_domain_registry": [
        "idx_config_domain_registry_lookup",
        "idx_config_domain_registry_advisor",
        "idx_config_domain_registry_payload_gin",
        "uq_config_domain_registry_active_domain_scope",
    ],
    "messages": ["idx_messages_status", "idx_messages_sender_id", "idx_messages_conversation_id", "idx_created_at"],
    "message_notify_dedupe": ["uq_message_notify_dedupe_advisor_message_recipient", "idx_message_notify_dedupe_lookup", "idx_message_notify_dedupe_message"],
    "profile_visibility_settings": ["idx_profile_visibility_settings_advisor_visibility", "idx_profile_visibility_settings_people_lists", "idx_profile_visibility_settings_rules_gin"],
    "relationship_requests": ["uq_relationship_requests_pending_unique", "idx_relationship_requests_incoming", "idx_relationship_requests_outgoing", "idx_relationship_requests_payload_gin"],
}

DOCUMENTED_FIELDS = {
    "advisors": ["id", "name", "gcs_bucket", "auth_config", "status", "social_links", "parent_company", "work_email", "website", "logo_path", "icon_path", "created_at"],
    "profiles": [
        "user_id", "advisor_id", "email", "full_name", "avatar_path", "role", "tier", "ui_language", "last_typed_lang",
        "balance", "country_code", "referred_by", "status", "joined_at", "phone_number", "birth_date", "identity_doc_path",
        "online_status", "projects_busy_count", "projects_done_count", "projects_created_count", "is_bot", "fcm_tokens",
    ],
    "conversations": ["id", "advisor_id", "type", "related_request_id", "last_message_at", "metadata", "status", "deleted_at"],
    "conversation_participants": ["conversation_id", "user_id", "joined_at", "unread_count"],
    "messages": [
        "id", "conversation_id", "sender_id", "advisor_id", "content_original", "src_lang", "content_pivot",
        "text_translations", "is_read", "created_at", "status", "delivered_at", "read_at", "type", "metadata",
        "client_message_id",
    ],
    "message_notify_dedupe": ["advisor_id", "message_id", "recipient_user_id", "route_selected", "notify_state", "created_at", "sent_at", "attempts", "last_attempt_at", "last_error"],
    "config_domain_registry": ["id", "domain_key", "scope_kind", "scope_ref", "advisor_id", "payload", "version", "is_active", "description", "created_at", "updated_at"],
    "profile_visibility_settings": [
        "user_id", "advisor_id", "profile_visibility", "discoverable_in_people_lists", "discoverable_in_search",
        "allow_contact_requests", "allow_group_invites", "visibility_rules", "visibility_changed_at", "visibility_changed_by",
        "created_at", "updated_at",
    ],
    "invitations": ["id", "email", "token", "advisor_id", "target_role", "invited_by", "status", "created_at", "expires_at", "avatar_path"],
}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _elapsed_ms(start: float) -> int:
    return int((time.perf_counter() - start) * 1000)


def _supabase_base_url() -> str:
    return (os.environ.get("PRG2_SUPABASE_URL") or os.environ.get("SUPABASE_URL") or "https://db.otmega.com").rstrip("/")


def _supabase_project_id(url: str) -> str:
    configured = os.environ.get("PRG2_SUPABASE_PROJECT_ID") or os.environ.get("SUPABASE_PROJECT_ID")
    if configured:
        return configured
    host = urllib.parse.urlparse(url).hostname or ""
    return host.split(".")[0] if host.endswith(".supabase.co") else ""


def _supabase_headers(*, count: bool = False) -> dict:
    key = os.environ.get("PRG2_SUPABASE_SERVICE_ROLE_KEY") or os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not key:
        raise RuntimeError("Supabase service role key is not configured.")
    headers = {
        "Accept": "application/json",
        "apikey": key,
        "Authorization": f"Bearer {key}",
    }
    if count:
        headers["Prefer"] = "count=exact"
    return headers


def _read_json_url(url: str, *, timeout: int = 8) -> tuple[dict, int, int]:
    start = time.perf_counter()
    req = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "otmega-admin-console/1.0"}, method="GET")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        payload = json.loads(resp.read().decode("utf-8") or "{}")
        return payload if isinstance(payload, dict) else {}, resp.status, _elapsed_ms(start)


def _supabase_get(table: str, params: dict[str, str], *, timeout: int = 10, count: bool = False) -> tuple[list[dict], int, int, str | None]:
    query = urllib.parse.urlencode(params, safe=",().:*->")
    url = f"{_supabase_base_url()}/rest/v1/{table}?{query}"
    start = time.perf_counter()
    req = urllib.request.Request(url, headers=_supabase_headers(count=count), method="GET")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        rows = json.loads(resp.read().decode("utf-8") or "[]")
        return rows if isinstance(rows, list) else [], resp.status, _elapsed_ms(start), resp.headers.get("Content-Range")


def _content_range_total(content_range: str | None) -> int | None:
    if not content_range or "/" not in content_range:
        return None
    total = content_range.rsplit("/", 1)[-1]
    if total == "*":
        return None
    try:
        return int(total)
    except ValueError:
        return None


def _safe_int(name: str, default: int, min_value: int, max_value: int) -> int:
    try:
        value = int(request.args.get(name, str(default)))
    except (TypeError, ValueError):
        value = default
    return min(max_value, max(min_value, value))


def _message_model(metadata: object) -> dict:
    if not isinstance(metadata, dict):
        return {"requested": None, "actual": None, "used_fallback": None, "selection_reason": "no_model_metadata"}
    model = metadata.get("wf1_translation_model")
    if not isinstance(model, dict):
        context = metadata.get("message_language_context")
        if isinstance(context, dict) and isinstance(context.get("wf1_model"), dict):
            model = context["wf1_model"]
    if not isinstance(model, dict):
        return {"requested": None, "actual": None, "used_fallback": None, "selection_reason": "no_model_metadata"}
    return {
        "requested": model.get("requested") if isinstance(model.get("requested"), dict) else None,
        "actual": model.get("actual") if isinstance(model.get("actual"), dict) else None,
        "used_fallback": model.get("used_fallback"),
        "selection_reason": model.get("selection_reason"),
    }


def _language_context(message: dict) -> dict:
    metadata = message.get("metadata") if isinstance(message.get("metadata"), dict) else {}
    context = metadata.get("message_language_context") if isinstance(metadata, dict) else None
    if not isinstance(context, dict):
        context = metadata.get("voice_language_context") if isinstance(metadata, dict) else None
    if not isinstance(context, dict):
        context = {}
    source_lang = context.get("source_lang") or message.get("src_lang") or metadata.get("src_lang")
    target_langs = context.get("target_langs")
    if not isinstance(target_langs, list):
        translations = message.get("text_translations")
        target_langs = list(translations.keys()) if isinstance(translations, dict) else []
    targets = context.get("targets") if isinstance(context.get("targets"), list) else []
    return {
        "phase": context.get("phase") or "unknown",
        "source_lang": source_lang,
        "target_langs": target_langs,
        "targets": targets,
        "translation_langs": context.get("translation_langs") if isinstance(context.get("translation_langs"), list) else target_langs,
    }


def _detect_data_kind(message: dict) -> str:
    msg_type = str(message.get("type") or "").strip().lower()
    metadata = message.get("metadata") if isinstance(message.get("metadata"), dict) else {}
    if msg_type:
        return msg_type
    metadata_type = str(metadata.get("message_type") or metadata.get("type") or "").strip().lower()
    return metadata_type or "unknown"


@supabase_monitor_bp.get("/api/console/supabase/status")
@require_capability("console.view_supabase_monitor")
def supabase_status():
    try:
        payload, http_status, latency_ms = _read_json_url(STATUS_API_URL, timeout=8)
        incidents = payload.get("incidents") if isinstance(payload.get("incidents"), list) else []
        scheduled = payload.get("scheduled_maintenances") if isinstance(payload.get("scheduled_maintenances"), list) else []
        return jsonify({
            "status": "ok",
            "http_status": http_status,
            "latency_ms": latency_ms,
            "indicator": (payload.get("status") or {}).get("indicator"),
            "description": (payload.get("status") or {}).get("description"),
            "incidents": incidents[:8],
            "scheduled_maintenances": scheduled[:8],
            "checked_at": _now_iso(),
            "source_url": "https://status.supabase.com/",
        })
    except Exception as exc:
        return jsonify({
            "status": "error",
            "message": f"Supabase status lookup failed: {type(exc).__name__}: {exc}",
            "checked_at": _now_iso(),
            "source_url": "https://status.supabase.com/",
        }), 502


@supabase_monitor_bp.get("/api/console/supabase/database-overview")
@require_capability("console.view_supabase_monitor")
def supabase_database_overview():
    base_url = _supabase_base_url()
    project_id = _supabase_project_id(base_url)
    tables = []
    errors = []
    start = time.perf_counter()
    for table in IMPORTANT_TABLES:
        params = {"select": table["select"], "limit": "0"}
        if table.get("advisor_filter"):
            params["advisor_id"] = f"eq.{ADVISOR_ID}"
        try:
            _rows, http_status, latency_ms, content_range = _supabase_get(table["name"], params, timeout=8, count=True)
            tables.append({
                "name": table["name"],
                "status": "ok" if 200 <= http_status < 300 else "warn",
                "http_status": http_status,
                "latency_ms": latency_ms,
                "row_count": _content_range_total(content_range),
                "content_range": content_range,
                "notes": table["notes"],
                "documented_field_count": len(DOCUMENTED_FIELDS.get(table["name"], [])),
                "documented_fields": DOCUMENTED_FIELDS.get(table["name"], []),
                "documented_indexes": DOCUMENTED_INDEXES.get(table["name"], []),
            })
        except urllib.error.HTTPError as exc:
            tables.append({
                "name": table["name"],
                "status": "error",
                "http_status": exc.code,
                "latency_ms": None,
                "row_count": None,
                "content_range": None,
                "notes": table["notes"],
                "documented_field_count": len(DOCUMENTED_FIELDS.get(table["name"], [])),
                "documented_fields": DOCUMENTED_FIELDS.get(table["name"], []),
                "documented_indexes": DOCUMENTED_INDEXES.get(table["name"], []),
            })
            errors.append(f"{table['name']}: HTTP {exc.code}")
        except Exception as exc:
            tables.append({
                "name": table["name"],
                "status": "error",
                "http_status": None,
                "latency_ms": None,
                "row_count": None,
                "content_range": None,
                "notes": table["notes"],
                "documented_field_count": len(DOCUMENTED_FIELDS.get(table["name"], [])),
                "documented_fields": DOCUMENTED_FIELDS.get(table["name"], []),
                "documented_indexes": DOCUMENTED_INDEXES.get(table["name"], []),
            })
            errors.append(f"{table['name']}: {type(exc).__name__}")

    return jsonify({
        "status": "ok" if not errors else "warn",
        "project": {
            "url": base_url,
            "project_id": project_id,
            "dashboard_url": f"https://supabase.com/dashboard/project/{project_id}" if project_id else None,
            "advisor_id": ADVISOR_ID,
        },
        "tables": tables,
        "checklist": [
            "Confirm the target advisor_id before any data repair.",
            "Check messages.metadata before changing LIP/WF1 records.",
            "Use service-role only through console backend endpoints, never from frontend.",
            "Avoid infrastructure operations while Supabase status is degraded.",
            "Keep RLS/grant changes out of operational data repair scripts unless explicitly requested.",
        ],
        "errors": errors,
        "latency_ms": _elapsed_ms(start),
        "checked_at": _now_iso(),
    })


@supabase_monitor_bp.get("/api/console/supabase/lip-wf1-audit")
@require_capability("console.view_supabase_monitor")
def supabase_lip_wf1_audit():
    limit = _safe_int("limit", 3, 1, 100)
    advisor_id = _safe_int("advisor_id", ADVISOR_ID, 1, 999999)
    conversation_id = str(request.args.get("conversation_id") or "").strip()
    created_from = str(request.args.get("created_at_from") or "").strip()
    created_to = str(request.args.get("created_at_to") or "").strip()

    params = {
        "select": "id,conversation_id,sender_id,advisor_id,content_original,src_lang,content_pivot,text_translations,created_at,status,type,metadata,client_message_id",
        "advisor_id": f"eq.{advisor_id}",
        "order": "created_at.desc",
        "limit": str(limit),
    }
    if conversation_id:
        params["conversation_id"] = f"eq.{conversation_id}"
    if created_from and created_to:
        params["and"] = f"(created_at.gte.{created_from},created_at.lte.{created_to})"
    elif created_from:
        params["created_at"] = f"gte.{created_from}"
    elif created_to:
        params["created_at"] = f"lte.{created_to}"

    rows, http_status, latency_ms, _content_range = _supabase_get("messages", params, timeout=12)
    user_ids = sorted({str(row.get("sender_id")) for row in rows if row.get("sender_id")})
    for row in rows:
        context = _language_context(row)
        for target in context.get("targets") or []:
            if isinstance(target, dict) and target.get("user_id"):
                user_ids.append(str(target["user_id"]))
    user_ids = sorted(set(user_ids))
    profiles = {}
    if user_ids:
        profile_rows, _profile_status, _profile_latency, _ = _supabase_get(
            "profiles",
            {
                "select": "user_id,email,full_name,last_typed_lang,role,country_code",
                "advisor_id": f"eq.{advisor_id}",
                "user_id": f"in.({','.join(user_ids)})",
                "limit": str(len(user_ids)),
            },
            timeout=10,
        )
        profiles = {str(profile.get("user_id")): profile for profile in profile_rows if profile.get("user_id")}

    audit_rows = []
    for row in rows:
        sender_id = str(row.get("sender_id") or "")
        context = _language_context(row)
        model = _message_model(row.get("metadata"))
        recipients = []
        for index, target in enumerate(context.get("targets") or []):
            if not isinstance(target, dict):
                continue
            user_id = str(target.get("user_id") or "")
            profile = profiles.get(user_id, {})
            recipients.append({
                "user_id": user_id,
                "email": profile.get("email"),
                "full_name": profile.get("full_name"),
                "target_lang": target.get("target_lang"),
                "target_lang_source": target.get("target_lang_source"),
                "target_index": target.get("target_index", index),
            })
        if not recipients:
            for index, lang in enumerate(context.get("target_langs") or []):
                recipients.append({"user_id": None, "email": None, "full_name": None, "target_lang": lang, "target_lang_source": "target_langs", "target_index": index})
        sender_profile = profiles.get(sender_id, {})
        audit_rows.append({
            "created_at": row.get("created_at"),
            "message_id": row.get("id"),
            "conversation_id": row.get("conversation_id"),
            "sender": {
                "user_id": sender_id,
                "email": sender_profile.get("email"),
                "full_name": sender_profile.get("full_name"),
            },
            "recipients": recipients,
            "source_lang": context.get("source_lang"),
            "target_langs": context.get("target_langs"),
            "data_kind": _detect_data_kind(row),
            "status": row.get("status"),
            "content_original": row.get("content_original"),
            "content_pivot": row.get("content_pivot"),
            "text_translations": row.get("text_translations"),
            "requested_model": (model.get("requested") or {}).get("model") if isinstance(model.get("requested"), dict) else None,
            "actual_model": (model.get("actual") or {}).get("model") if isinstance(model.get("actual"), dict) else None,
            "requested_provider": (model.get("requested") or {}).get("provider") if isinstance(model.get("requested"), dict) else None,
            "actual_provider": (model.get("actual") or {}).get("provider") if isinstance(model.get("actual"), dict) else None,
            "used_fallback": model.get("used_fallback"),
            "selection_reason": model.get("selection_reason"),
            "language_phase": context.get("phase"),
            "raw_fields": {
                "id": row.get("id"),
                "conversation_id": row.get("conversation_id"),
                "sender_id": row.get("sender_id"),
                "advisor_id": row.get("advisor_id"),
                "content_original": row.get("content_original"),
                "src_lang": row.get("src_lang"),
                "content_pivot": row.get("content_pivot"),
                "text_translations": row.get("text_translations"),
                "created_at": row.get("created_at"),
                "status": row.get("status"),
                "type": row.get("type"),
                "metadata": row.get("metadata"),
                "client_message_id": row.get("client_message_id"),
            },
        })

    return jsonify({
        "status": "ok",
        "http_status": http_status,
        "latency_ms": latency_ms,
        "filters": {
            "advisor_id": advisor_id,
            "conversation_id": conversation_id or None,
            "created_at_from": created_from or None,
            "created_at_to": created_to or None,
            "limit": limit,
        },
        "rows": audit_rows,
        "checked_at": _now_iso(),
    })
