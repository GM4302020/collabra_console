# FILE: ~/otmega/otmega_app/console/admin_backend/admin_api/user_ops_routes.py
# ماموریت: API read-only برای فهرست عملیاتی کاربران، سلامت بنرلیست و شاخص های استفاده.

import json
import logging
import os
import re
import urllib.parse
import urllib.request
from datetime import datetime, timezone

from flask import Blueprint, jsonify, request

from admin_api.auth import resolve_actor
from admin_api.guards import require_capability
from admin_api.profile_adapter import _signed_avatar_url

user_ops_bp = Blueprint("console_user_ops", __name__)
logger = logging.getLogger(__name__)

ADVISOR_ID = int(os.environ.get("CONSOLE_ADVISOR_ID", "20018"))
USER_ZERO_ID = os.environ.get("CONSOLE_USER_ZERO_ID", "9197bacb-2387-4639-814f-9d643bbfb245")
ADVISOR_USER_ID = os.environ.get("CONSOLE_ADVISOR_USER_ID", "00000000-0000-0000-0000-200180000000")
GUEST_BANNER_USER_ID = os.environ.get("CONSOLE_GUEST_BANNER_USER_ID", "00000000-0000-0000-0000-200180000001")
PROFILE_SELECT = (
    "user_id,advisor_id,email,full_name,role,tier,balance,country_code,"
    "avatar_path,online_status,last_typed_lang,joined_at,status,fcm_tokens"
)
BANNER_PROFILE_SELECT = "user_id,email,full_name,avatar_path,country_code,online_status,role,is_bot,joined_at"
VISIBILITY_SELECT = "user_id,advisor_id,visibility_rules,profile_visibility,updated_at,visibility_changed_at"
ALLOWED_SORTS = {
    "profile_order": None,
    "email": "email",
    "full_name": "full_name",
    "balance": "balance",
    "tier": "tier",
    "joined_at": "joined_at",
    "online_status": "online_status",
    "messages_sent": None,
    "banner_count": None,
    "last_message_at": None,
}
UUID_PATTERN = re.compile(r"^[0-9a-fA-F-]{32,36}$")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _rest_headers(prefer_count: bool = False) -> dict[str, str] | None:
    service_role_key = os.environ.get("PRG2_SUPABASE_SERVICE_ROLE_KEY")
    if not service_role_key:
        return None
    headers = {
        "Accept": "application/json",
        "apikey": service_role_key,
        "Authorization": f"Bearer {service_role_key}",
    }
    if prefer_count:
        headers["Prefer"] = "count=exact"
    return headers


def _supabase_url() -> str | None:
    value = (os.environ.get("PRG2_SUPABASE_URL") or "").rstrip("/")
    return value or None


def _get_json(table: str, params: dict[str, str], *, prefer_count: bool = False, timeout: int = 12) -> tuple[list[dict], int | None]:
    base_url = _supabase_url()
    headers = _rest_headers(prefer_count=prefer_count)
    if not base_url or not headers:
        raise RuntimeError("Supabase URL or service role key is not configured.")
    query = urllib.parse.urlencode(params, safe=",().*:")
    rest_request = urllib.request.Request(f"{base_url}/rest/v1/{table}?{query}", headers=headers, method="GET")
    with urllib.request.urlopen(rest_request, timeout=timeout) as response:
        payload = json.loads(response.read().decode("utf-8") or "[]")
        content_range = response.headers.get("Content-Range")
    total = None
    if content_range and "/" in content_range:
        try:
            total = int(content_range.rsplit("/", 1)[-1])
        except ValueError:
            total = None
    return payload if isinstance(payload, list) else [], total


def _patch_json(table: str, filters: dict[str, str], payload: dict, *, timeout: int = 12) -> list[dict]:
    base_url = _supabase_url()
    headers = _rest_headers()
    if not base_url or not headers:
        raise RuntimeError("Supabase URL or service role key is not configured.")
    query = urllib.parse.urlencode(filters, safe=",().*:")
    patch_headers = {**headers, "Content-Type": "application/json", "Prefer": "return=representation"}
    rest_request = urllib.request.Request(
        f"{base_url}/rest/v1/{table}?{query}",
        data=json.dumps(payload).encode("utf-8"),
        headers=patch_headers,
        method="PATCH",
    )
    with urllib.request.urlopen(rest_request, timeout=timeout) as response:
        response_payload = json.loads(response.read().decode("utf-8") or "[]")
    return response_payload if isinstance(response_payload, list) else []


def _count_rows(table: str, filters: dict[str, str]) -> int:
    _rows, total = _get_json(table, {"select": "*", "limit": "0", **filters}, prefer_count=True, timeout=8)
    return int(total or 0)


def _safe_count_rows(table: str, filters: dict[str, str]) -> int:
    try:
        return _count_rows(table, filters)
    except Exception:
        return 0


def _to_int(value, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _to_float(value, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _list_from_rule(value) -> list[str]:
    if isinstance(value, list):
        return [str(item) for item in value if item]
    if isinstance(value, dict):
        return [str(key) for key, enabled in value.items() if enabled]
    return []


def _entries_from_rule(value) -> dict[str, dict]:
    if isinstance(value, list):
        return {str(item): {"enabled": True} for item in value if item}
    if not isinstance(value, dict):
        return {}
    return {
        str(key): dict(entry) if isinstance(entry, dict) else {"enabled": bool(entry)}
        for key, entry in value.items()
        if key and entry
    }


def _normalize_rules(value) -> dict:
    return dict(value) if isinstance(value, dict) else {}


def _normalize_role(value) -> str:
    normalized = str(value or "guest").strip().lower().replace(" ", "_")
    if normalized in {"super_admin", "superadmin"}:
        return "s_admin"
    if normalized == "visitor":
        return "guest"
    return normalized if normalized in {"guest", "customer", "staff", "admin", "s_admin", "service_role", "system"} else "guest"


def _email_domain(value) -> str:
    normalized = str(value or "").strip().lower()
    if "@" not in normalized:
        return ""
    return normalized.rsplit("@", 1)[-1].strip()


def _same_email_domain(left, right) -> bool:
    left_domain = _email_domain(left)
    right_domain = _email_domain(right)
    return bool(left_domain and right_domain and left_domain == right_domain)


def _fcm_counts(fcm_tokens) -> dict:
    values = list(fcm_tokens.values()) if isinstance(fcm_tokens, dict) else []
    push_tokens = [str(value) for value in values if len(str(value)) > 20]
    session_markers = [str(value) for value in values if 0 < len(str(value)) <= 20]
    return {
        "system_notification_tokens": len(push_tokens),
        "internal_notification_markers": len(session_markers),
        "device_entries": len(values),
    }


def _format_age_seconds(timestamp_value: str | None) -> int | None:
    if not timestamp_value:
        return None
    try:
        parsed = datetime.fromisoformat(timestamp_value.replace("Z", "+00:00"))
        return max(0, int((datetime.now(timezone.utc) - parsed).total_seconds()))
    except ValueError:
        return None


def _role_label(role: str | None, user_id: str) -> str:
    if user_id == USER_ZERO_ID:
        return "User Zero"
    normalized = (role or "guest").strip().lower()
    return {
        "s_admin": "S Admin",
        "admin": "Admin",
        "staff": "Staff",
        "customer": "Customer",
        "guest": "Guest",
        "service_role": "Service Role",
    }.get(normalized, normalized.replace("_", " ").title())


def _profile_by_user_id(user_id: str) -> dict | None:
    rows, _total = _get_json(
        "profiles",
        {
            "select": PROFILE_SELECT,
            "advisor_id": f"eq.{ADVISOR_ID}",
            "user_id": f"eq.{user_id}",
            "limit": "1",
        },
        timeout=8,
    )
    return rows[0] if rows and isinstance(rows[0], dict) else None


def _visibility_row_by_user_id(user_id: str) -> dict | None:
    rows, _total = _get_json(
        "profile_visibility_settings",
        {
            "select": VISIBILITY_SELECT,
            "advisor_id": f"eq.{ADVISOR_ID}",
            "user_id": f"eq.{user_id}",
            "limit": "1",
        },
        timeout=8,
    )
    return rows[0] if rows and isinstance(rows[0], dict) else None


def _build_active_relation_entry(counterpart_profile: dict, timestamp: str) -> dict:
    counterpart_user_id = str(counterpart_profile.get("user_id") or "")
    label = counterpart_profile.get("full_name") or counterpart_profile.get("email") or counterpart_user_id
    return {
        "counterpart_user_id": counterpart_user_id,
        "counterpart_email": str(counterpart_profile.get("email") or "").strip().lower(),
        "counterpart_label": label,
        "counterpart_role": counterpart_profile.get("role"),
        "state": "active",
        "accepted_at": timestamp,
        "last_activity_at": timestamp,
        "repair_source": "admin_console_user_operations",
    }


def _repair_block_reason(target_id: str, target: dict | None) -> str | None:
    if target_id in {USER_ZERO_ID, ADVISOR_USER_ID, GUEST_BANNER_USER_ID}:
        return "synthetic_or_system_target"
    role = _normalize_role((target or {}).get("role"))
    if role in {"s_admin", "admin", "staff", "service_role", "system"}:
        return "privileged_policy_managed"
    return None


def _is_repairable_banner_target(target_id: str, target: dict | None) -> bool:
    return _repair_block_reason(target_id, target) is None


def _repair_active_list_target(owner_user_id: str, counterpart_user_id: str) -> dict:
    owner_profile = _profile_by_user_id(owner_user_id)
    counterpart_profile = _profile_by_user_id(counterpart_user_id)
    if not isinstance(owner_profile, dict):
        raise LookupError("Owner profile not found.")
    if not isinstance(counterpart_profile, dict):
        raise LookupError("Counterpart profile not found.")
    if owner_user_id == counterpart_user_id:
        raise ValueError("Owner and counterpart must be different users.")
    owner_block_reason = _repair_block_reason(owner_user_id, owner_profile)
    counterpart_block_reason = _repair_block_reason(counterpart_user_id, counterpart_profile)
    if owner_block_reason:
        raise ValueError(f"Owner cannot be repaired through this operation: {owner_block_reason}.")
    if counterpart_block_reason:
        raise ValueError(f"Counterpart cannot be repaired through this operation: {counterpart_block_reason}.")

    visibility_row = _visibility_row_by_user_id(owner_user_id)
    if not isinstance(visibility_row, dict):
        raise LookupError("Owner visibility row not found.")

    current_rules = _normalize_rules(visibility_row.get("visibility_rules"))
    active_targets = _entries_from_rule(current_rules.get("active_list_targets"))
    removed_targets = _normalize_rules(current_rules.get("removed_from_list_targets"))
    pending_targets = _entries_from_rule(current_rules.get("registered_pending_list_relations"))
    before_active_count = len(active_targets)
    before_removed = bool(removed_targets.get(counterpart_user_id))
    timestamp = _now_iso()

    active_targets[counterpart_user_id] = _build_active_relation_entry(counterpart_profile, timestamp)
    removed_targets.pop(counterpart_user_id, None)
    pending_targets.pop(counterpart_user_id, None)

    next_rules = dict(current_rules)
    next_rules["active_list_targets"] = active_targets
    if removed_targets:
        next_rules["removed_from_list_targets"] = removed_targets
    else:
        next_rules.pop("removed_from_list_targets", None)
    if pending_targets:
        next_rules["registered_pending_list_relations"] = pending_targets
    else:
        next_rules.pop("registered_pending_list_relations", None)

    updated_rows = _patch_json(
        "profile_visibility_settings",
        {"advisor_id": f"eq.{ADVISOR_ID}", "user_id": f"eq.{owner_user_id}"},
        {"visibility_rules": next_rules, "visibility_changed_at": timestamp},
        timeout=10,
    )
    if not updated_rows:
        raise RuntimeError("Visibility repair write returned no rows.")

    return {
        "owner_user_id": owner_user_id,
        "counterpart_user_id": counterpart_user_id,
        "before_active_count": before_active_count,
        "after_active_count": len(active_targets),
        "removed_marker_cleared": before_removed,
        "visibility_changed_at": timestamp,
        "target": _banner_target(counterpart_profile, "admin_repair"),
    }


def _profile_params(page: int, page_size: int, sort: str, direction: str, search: str, role: str, status: str, online_status: str) -> dict[str, str]:
    offset = (page - 1) * page_size
    params = {
        "select": PROFILE_SELECT,
        "advisor_id": f"eq.{ADVISOR_ID}",
        "limit": str(page_size),
        "offset": str(offset),
    }
    if search:
        escaped = search.replace("*", "").replace("%", "")
        if UUID_PATTERN.match(escaped):
            params["user_id"] = f"eq.{escaped}"
        else:
            params["or"] = f"(email.ilike.*{escaped}*,full_name.ilike.*{escaped}*)"
    if role and role != "all":
        params["role"] = f"eq.{role}"
    if status and status != "all":
        params["status"] = f"eq.{status}"
    if online_status and online_status != "all":
        params["online_status"] = f"eq.{online_status}"
    if sort != "profile_order" and ALLOWED_SORTS.get(sort):
        params["order"] = f"{ALLOWED_SORTS[sort]}.{direction}"
    else:
        params["order"] = f"joined_at.{direction},user_id.{direction}"
    return params


def _fetch_visibility(user_ids: list[str]) -> dict[str, dict]:
    compact_ids = list(dict.fromkeys([user_id for user_id in user_ids if user_id]))
    if not compact_ids:
        return {}
    visibility_by_user: dict[str, dict] = {}
    for index in range(0, len(compact_ids), 100):
        chunk_ids = compact_ids[index:index + 100]
        rows, _total = _get_json(
            "profile_visibility_settings",
            {
                "select": VISIBILITY_SELECT,
                "advisor_id": f"eq.{ADVISOR_ID}",
                "user_id": f"in.({','.join(chunk_ids)})",
            },
            timeout=10,
        )
        visibility_by_user.update({str(row.get("user_id")): row for row in rows if isinstance(row, dict)})
    return visibility_by_user


def _fetch_profiles_by_ids(user_ids: list[str]) -> dict[str, dict]:
    compact_ids = list(dict.fromkeys([user_id for user_id in user_ids if user_id]))[:250]
    if not compact_ids:
        return {}
    rows, _total = _get_json(
        "profiles",
        {
            "select": "user_id,email,full_name,avatar_path,online_status",
            "advisor_id": f"eq.{ADVISOR_ID}",
            "user_id": f"in.({','.join(compact_ids)})",
        },
        timeout=10,
    )
    return {str(row.get("user_id")): row for row in rows if isinstance(row, dict)}


def _fetch_invitations_by_inviter(user_ids: list[str]) -> dict[str, list[dict]]:
    compact_ids = list(dict.fromkeys([user_id for user_id in user_ids if user_id]))
    if not compact_ids:
        return {}
    invitations_by_inviter: dict[str, list[dict]] = {user_id: [] for user_id in compact_ids}
    try:
        rows, _total = _get_json(
            "invitations",
            {
                "select": "id,email,status,created_at,invited_by",
                "advisor_id": f"eq.{ADVISOR_ID}",
                "invited_by": f"in.({','.join(compact_ids)})",
                "order": "created_at.desc",
                "limit": "10000",
            },
            timeout=10,
        )
    except Exception:
        return invitations_by_inviter
    seen: set[tuple[str, str]] = set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        inviter_id = str(row.get("invited_by") or "")
        email = str(row.get("email") or "").strip().lower()
        if not inviter_id or not email or inviter_id not in invitations_by_inviter:
            continue
        key = (inviter_id, email)
        if key in seen:
            continue
        seen.add(key)
        invitations_by_inviter[inviter_id].append(row)
    return invitations_by_inviter


def _fetch_banner_candidate_profiles() -> dict[str, dict]:
    rows, _total = _get_json(
        "profiles",
        {
            "select": BANNER_PROFILE_SELECT,
            "advisor_id": f"eq.{ADVISOR_ID}",
            "limit": "1000",
            "order": "joined_at.desc,user_id.asc",
        },
        timeout=12,
    )
    return {str(row.get("user_id")): row for row in rows if isinstance(row, dict) and row.get("user_id")}


def _empty_usage_stats() -> dict:
    return {
        "messages_sent": 0,
        "last_message_at": None,
        "last_message_latency_seconds": None,
        "conversations": {
            "total": 0,
            "active_with_chat": 0,
            "active_without_chat": 0,
            "unread_total": 0,
            "banner_list_with_chat": 0,
            "upstream_system_with_chat": 0,
        },
        "chat_target_ids": [],
        "notifications": {"system_push_total": 0, "internal_total": 0},
    }


def _default_usage_map(user_ids: list[str]) -> dict[str, dict]:
    return {user_id: _empty_usage_stats() for user_id in user_ids}


def _apply_message_stats(user_ids: list[str], usage_by_user: dict[str, dict]) -> None:
    if not user_ids:
        return
    try:
        rows, _total = _get_json(
            "messages",
            {
                "select": "sender_id,created_at",
                "advisor_id": f"eq.{ADVISOR_ID}",
                "sender_id": f"in.({','.join(user_ids)})",
                "order": "created_at.desc",
                "limit": "10000",
            },
            timeout=12,
        )
    except Exception:
        return
    for row in rows:
        if not isinstance(row, dict):
            continue
        sender_id = str(row.get("sender_id") or "")
        if sender_id not in usage_by_user:
            continue
        usage_by_user[sender_id]["messages_sent"] += 1
        if not usage_by_user[sender_id]["last_message_at"]:
            last_at = row.get("created_at")
            usage_by_user[sender_id]["last_message_at"] = last_at
            usage_by_user[sender_id]["last_message_latency_seconds"] = _format_age_seconds(last_at)


def _apply_conversation_stats(user_ids: list[str], usage_by_user: dict[str, dict]) -> None:
    if not user_ids:
        return
    try:
        participant_rows, _total = _get_json(
            "conversation_participants",
            {
                "select": "user_id,conversation_id,unread_count",
                "user_id": f"in.({','.join(user_ids)})",
                "limit": "10000",
            },
            timeout=12,
        )
    except Exception:
        return
    conversation_to_viewers: dict[str, list[str]] = {}
    for row in participant_rows:
        if not isinstance(row, dict):
            continue
        user_id = str(row.get("user_id") or "")
        conversation_id = str(row.get("conversation_id") or "")
        if user_id not in usage_by_user or not conversation_id:
            continue
        usage_by_user[user_id]["conversations"]["total"] += 1
        usage_by_user[user_id]["conversations"]["unread_total"] += _to_int(row.get("unread_count"))
        conversation_to_viewers.setdefault(conversation_id, []).append(user_id)
    conversation_ids = list(conversation_to_viewers)[:10000]
    if not conversation_ids:
        return
    try:
        all_participant_rows, _total = _get_json(
            "conversation_participants",
            {
                "select": "user_id,conversation_id",
                "conversation_id": f"in.({','.join(conversation_ids)})",
                "limit": "10000",
            },
            timeout=12,
        )
    except Exception:
        all_participant_rows = []
    participants_by_conversation: dict[str, set[str]] = {}
    for row in all_participant_rows:
        if not isinstance(row, dict):
            continue
        conversation_id = str(row.get("conversation_id") or "")
        participant_id = str(row.get("user_id") or "")
        if conversation_id and participant_id:
            participants_by_conversation.setdefault(conversation_id, set()).add(participant_id)
    try:
        conversation_rows, _total = _get_json(
            "conversations",
            {
                "select": "id,status,last_message_at",
                "id": f"in.({','.join(conversation_ids)})",
                "limit": "10000",
            },
            timeout=12,
        )
    except Exception:
        return
    for row in conversation_rows:
        if not isinstance(row, dict):
            continue
        if row.get("status") != "active":
            continue
        conversation_id = str(row.get("id") or "")
        metric = "active_with_chat" if row.get("last_message_at") else "active_without_chat"
        for user_id in conversation_to_viewers.get(conversation_id, []):
            usage_by_user[user_id]["conversations"][metric] += 1
            for participant_id in participants_by_conversation.get(conversation_id, set()):
                if participant_id != user_id:
                    usage_by_user[user_id].setdefault("chat_target_ids", []).append(participant_id)


def _apply_notification_stats(user_ids: list[str], usage_by_user: dict[str, dict]) -> None:
    if not user_ids:
        return
    try:
        rows, _total = _get_json(
            "message_notify_dedupe",
            {
                "select": "recipient_user_id,route_selected",
                "recipient_user_id": f"in.({','.join(user_ids)})",
                "limit": "10000",
            },
            timeout=12,
        )
    except Exception:
        return
    for row in rows:
        if not isinstance(row, dict):
            continue
        user_id = str(row.get("recipient_user_id") or "")
        if user_id not in usage_by_user:
            continue
        if row.get("route_selected") == "push":
            usage_by_user[user_id]["notifications"]["system_push_total"] += 1
        else:
            usage_by_user[user_id]["notifications"]["internal_total"] += 1


def _usage_stats_map(user_ids: list[str]) -> dict[str, dict]:
    usage_by_user = _default_usage_map(user_ids)
    _apply_message_stats(user_ids, usage_by_user)
    _apply_conversation_stats(user_ids, usage_by_user)
    _apply_notification_stats(user_ids, usage_by_user)
    return usage_by_user


def _rule_enabled(rules: dict, key: str, target_id: str) -> bool:
    value = rules.get(key)
    if isinstance(value, dict):
        return bool(value.get(target_id))
    if isinstance(value, list):
        return target_id in [str(item) for item in value]
    return False


def _can_owner_hide_viewer(owner_id: str, owner_profile: dict | None, viewer_id: str, viewer_profile: dict | None) -> bool:
    owner_role = _normalize_role((owner_profile or {}).get("role"))
    viewer_role = _normalize_role((viewer_profile or {}).get("role"))
    if owner_id == USER_ZERO_ID:
        return viewer_id != USER_ZERO_ID and viewer_role in {"guest", "customer", "admin", "staff", "s_admin"}
    if owner_role == "s_admin":
        return viewer_role in {"guest", "customer", "admin", "staff"}
    if owner_role == "admin":
        return viewer_role == "staff" and _same_email_domain((owner_profile or {}).get("email"), (viewer_profile or {}).get("email"))
    return False


def _is_visible_banner_candidate(viewer_id: str, viewer_profile: dict, candidate: dict, viewer_rules: dict, candidate_visibility: dict | None, root_rules: dict) -> bool:
    target_id = str(candidate.get("user_id") or "")
    if not target_id or target_id == viewer_id:
        return False
    if target_id != ADVISOR_USER_ID and candidate.get("is_bot"):
        return False
    if target_id != ADVISOR_USER_ID and _rule_enabled(root_rules, "final_blocked_targets", target_id):
        return False
    if target_id != ADVISOR_USER_ID and _rule_enabled(viewer_rules, "removed_from_list_targets", target_id):
        return False
    candidate_rules = {}
    if isinstance(candidate_visibility, dict) and isinstance(candidate_visibility.get("visibility_rules"), dict):
        candidate_rules = candidate_visibility["visibility_rules"]
    if target_id != ADVISOR_USER_ID:
        hidden_rules = candidate_rules.get("hidden_in_list_viewers")
        has_explicit_hidden = isinstance(hidden_rules, dict) and viewer_id in hidden_rules
        if has_explicit_hidden:
            if bool(hidden_rules.get(viewer_id)):
                return False
        elif _can_owner_hide_viewer(target_id, candidate, viewer_id, viewer_profile):
            return False
    if target_id != ADVISOR_USER_ID and _rule_enabled(candidate_rules, "blocked_targets", viewer_id):
        return False
    return True


def _cached_avatar_url(profile: dict, avatar_url_cache: dict[str, str | None] | None = None) -> str | None:
    avatar_path = profile.get("avatar_path")
    if not isinstance(avatar_path, str) or not avatar_path:
        return None
    if avatar_url_cache is None:
        return _signed_avatar_url(avatar_path)
    if avatar_path not in avatar_url_cache:
        avatar_url_cache[avatar_path] = _signed_avatar_url(avatar_path)
    return avatar_url_cache.get(avatar_path)


def _banner_target(profile: dict, source: str) -> dict:
    return {
        "user_id": str(profile.get("user_id") or ""),
        "email": profile.get("email"),
        "full_name": profile.get("full_name") or ("Advisor" if profile.get("user_id") == ADVISOR_USER_ID else "Guest" if profile.get("user_id") == GUEST_BANNER_USER_ID else None),
        "avatar_path": profile.get("avatar_path"),
        "country_code": profile.get("country_code"),
        "online_status": profile.get("online_status"),
        "role": profile.get("role"),
        "source": source,
    }


def _synthetic_target(user_id: str) -> dict:
    if user_id == ADVISOR_USER_ID:
        return {
            "user_id": ADVISOR_USER_ID,
            "email": "advisor@otmega.internal",
            "full_name": "Advisor",
            "role": "advisor",
            "online_status": None,
            "country_code": "us",
        }
    if user_id == GUEST_BANNER_USER_ID:
        return {
            "user_id": GUEST_BANNER_USER_ID,
            "email": "guest-system-20018@otmega.internal",
            "full_name": "Guest",
            "role": "guest",
            "online_status": None,
            "country_code": None,
        }
    return {"user_id": user_id, "email": None, "full_name": None, "role": None, "online_status": None}


def _is_upstream_system_target(target_id: str, target: dict | None) -> bool:
    if target_id in {USER_ZERO_ID}:
        return True
    if target_id in {ADVISOR_USER_ID, GUEST_BANNER_USER_ID}:
        return False
    role = str((target or {}).get("role") or "").strip().lower()
    return role in {"s_admin", "admin", "staff", "service_role", "system"}


def _user_row(
    profile: dict,
    visibility: dict | None,
    banner_candidate_profiles: dict[str, dict],
    visibility_by_user: dict[str, dict],
    usage: dict,
    invitations: list[dict] | None = None,
) -> dict:
    user_id = str(profile.get("user_id") or "")
    visibility_rules = visibility.get("visibility_rules") if isinstance(visibility, dict) else {}
    rules = visibility_rules if isinstance(visibility_rules, dict) else {}
    active_entries = _entries_from_rule(rules.get("active_list_targets"))
    pending_entries = _entries_from_rule(rules.get("registered_pending_list_relations"))
    active_targets = list(active_entries)
    pending_targets = list(pending_entries)
    removed_targets = _list_from_rule(rules.get("removed_from_list_targets"))
    hidden_viewers = _list_from_rule(rules.get("hidden_in_list_viewers"))
    avatar_url_cache: dict[str, str | None] = {}
    root_visibility = visibility_by_user.get(USER_ZERO_ID, {})
    root_rules = root_visibility.get("visibility_rules") if isinstance(root_visibility.get("visibility_rules"), dict) else {}
    visible_ids: list[str] = []
    source_by_id: dict[str, str] = {}
    state_by_id: dict[str, str] = {}
    excluded_targets: list[dict] = []
    upstream_chat_target_ids: list[str] = []
    banner_chat_target_ids: list[str] = []
    chat_target_set = {str(target_id) for target_id in (usage.get("chat_target_ids") or []) if target_id}

    def add_visible(target_id: str, source: str, state: str = "visible") -> None:
        if not target_id or target_id == user_id or target_id in visible_ids:
            return
        target = banner_candidate_profiles.get(target_id) or _synthetic_target(target_id)
        if target_id not in {ADVISOR_USER_ID, GUEST_BANNER_USER_ID} and not _is_visible_banner_candidate(
            user_id,
            profile,
            target,
            rules,
            visibility_by_user.get(target_id),
            root_rules,
        ):
            excluded_targets.append({**_banner_target(target, source), "state": "excluded_by_visibility"})
            return
        visible_ids.append(target_id)
        source_by_id[target_id] = source
        state_by_id[target_id] = state

    add_visible(ADVISOR_USER_ID, "required", "required")
    add_visible(GUEST_BANNER_USER_ID, "required", "required")

    for target_id in usage.get("chat_target_ids") or []:
        if target_id == user_id:
            continue
        target = banner_candidate_profiles.get(target_id, {"user_id": target_id})
        if _is_upstream_system_target(target_id, target):
            upstream_chat_target_ids.append(target_id)
            excluded_targets.append({**_banner_target(target, "warmable_chat"), "state": "upstream_system"})
            continue
        if _rule_enabled(rules, "removed_from_list_targets", target_id):
            excluded_targets.append({**_banner_target(target, "warmable_chat"), "state": "removed_from_list"})
            continue
        if not _is_visible_banner_candidate(user_id, profile, target, rules, visibility_by_user.get(target_id), root_rules):
            excluded_targets.append({**_banner_target(target, "warmable_chat"), "state": "hidden_or_blocked"})
            continue
        banner_chat_target_ids.append(target_id)

    for target_id in active_targets:
        if target_id == user_id:
            continue
        target = banner_candidate_profiles.get(target_id, {"user_id": target_id})
        if _is_upstream_system_target(target_id, target):
            excluded_targets.append({**_banner_target(target, "stored_relation"), "state": "upstream_system"})
            continue
        add_visible(target_id, "stored_relation", "active")

    for target_id in pending_targets:
        if target_id == user_id:
            continue
        target = banner_candidate_profiles.get(target_id, {"user_id": target_id})
        if _is_upstream_system_target(target_id, target):
            excluded_targets.append({**_banner_target(target, "pending_relation"), "state": "upstream_system"})
            continue
        add_visible(target_id, "pending_relation", "pending")

    for invitation in invitations or []:
        if not isinstance(invitation, dict):
            continue
        invitation_status = str(invitation.get("status") or "").strip().lower()
        invitation_email = str(invitation.get("email") or "").strip().lower()
        if not invitation_email or invitation_status == "expired":
            continue
        registered_target = next(
            (
                target
                for target in banner_candidate_profiles.values()
                if str(target.get("email") or "").strip().lower() == invitation_email
            ),
            None,
        )
        if registered_target and registered_target.get("user_id") != user_id:
            add_visible(str(registered_target.get("user_id")), "invitation", "invited")
        elif invitation_status == "pending":
            placeholder_id = f"placeholder-invite:{invitation_email}"
            if placeholder_id not in visible_ids:
                visible_ids.append(placeholder_id)
                source_by_id[placeholder_id] = "pending_invitation"
                state_by_id[placeholder_id] = "pending"

    viewer_role = _normalize_role(profile.get("role"))
    if user_id == USER_ZERO_ID or viewer_role == "s_admin":
        for target_id, target in banner_candidate_profiles.items():
            if target_id == user_id or _is_upstream_system_target(target_id, target):
                continue
            add_visible(target_id, "privileged_profile", "visible")

    visible_ids = list(dict.fromkeys(visible_ids))
    usage = dict(usage)
    usage["conversations"] = dict(usage.get("conversations") or {})
    usage["conversations"]["banner_list_with_chat"] = len(banner_chat_target_ids)
    usage["conversations"]["upstream_system_with_chat"] = len(upstream_chat_target_ids)
    visible_targets = []
    warmable_targets = []
    for target_id in visible_ids[:100]:
        if target_id.startswith("placeholder-invite:"):
            email = target_id.replace("placeholder-invite:", "", 1)
            target = {"user_id": target_id, "email": email, "full_name": email, "role": "pending_invitation"}
        else:
            target = banner_candidate_profiles.get(target_id) or _synthetic_target(target_id)
        visible_targets.append({
            **_banner_target(target, source_by_id.get(target_id, "unknown")),
            "state": state_by_id.get(target_id, "visible"),
            "has_chat": target_id in chat_target_set,
        })
    for target_id in sorted(chat_target_set)[:100]:
        target = banner_candidate_profiles.get(target_id) or _synthetic_target(target_id)
        repair_block_reason = _repair_block_reason(target_id, target)
        warmable_targets.append({
            **_banner_target(target, "warmable_chat"),
            "state": "warmable",
            "shown": target_id in visible_ids,
            "repairable": bool(target_id not in visible_ids and repair_block_reason is None),
            "repair_block_reason": repair_block_reason,
        })
    fcm_counts = _fcm_counts(profile.get("fcm_tokens"))
    return {
        "user_id": user_id,
        "advisor_id": profile.get("advisor_id") or ADVISOR_ID,
        "email": profile.get("email"),
        "full_name": profile.get("full_name"),
        "role": profile.get("role") or "guest",
        "access_level": _role_label(profile.get("role"), user_id),
        "tier": _to_int(profile.get("tier")),
        "balance": f"{_to_float(profile.get('balance')):.2f}",
        "country_code": profile.get("country_code"),
        "avatar_path": profile.get("avatar_path"),
        "avatar_url": _cached_avatar_url(profile, avatar_url_cache),
        "online_status": profile.get("online_status") or "offline",
        "last_typed_lang": profile.get("last_typed_lang"),
        "joined_at": profile.get("joined_at"),
        "status": profile.get("status") or "active",
        "visibility": {
            "profile_visibility": visibility.get("profile_visibility") if isinstance(visibility, dict) else None,
            "updated_at": visibility.get("updated_at") if isinstance(visibility, dict) else None,
            "visibility_changed_at": visibility.get("visibility_changed_at") if isinstance(visibility, dict) else None,
            "active_banner_count": len(visible_ids),
            "stored_active_relation_count": len(active_targets),
            "visible_banner_count": len(visible_ids),
            "chat_banner_count": len(banner_chat_target_ids),
            "required_banner_count": len([target_id for target_id in visible_ids if target_id in {ADVISOR_USER_ID, GUEST_BANNER_USER_ID}]),
            "upstream_system_banner_count": len(upstream_chat_target_ids),
            "pending_banner_count": len(pending_targets),
            "removed_banner_count": len(removed_targets),
            "hidden_viewer_count": len(hidden_viewers),
            "invitation_banner_count": len([target for target in visible_targets if target.get("source") in {"invitation", "pending_invitation"}]),
            "warmable_chat_count": len(warmable_targets),
            "excluded_banner_count": len(excluded_targets),
            "active_targets": visible_targets,
            "visible_now_targets": visible_targets,
            "warmable_chat_targets": warmable_targets,
            "excluded_targets": excluded_targets[:100],
        },
        "notifications": fcm_counts,
        "usage": usage,
    }


@user_ops_bp.get("/api/console/users/operations")
@require_capability("console.view_user_operations")
def user_operations():
    try:
        page = max(1, min(_to_int(request.args.get("page"), 1), 500))
        page_size = max(10, min(_to_int(request.args.get("page_size"), 25), 100))
        sort = request.args.get("sort", "profile_order")
        if sort not in ALLOWED_SORTS:
            sort = "profile_order"
        direction = "desc" if request.args.get("direction", "asc").lower() == "desc" else "asc"
        search = (request.args.get("search") or "").strip()[:80]
        role = (request.args.get("role") or "all").strip()
        status = (request.args.get("status") or "all").strip()
        online_status = (request.args.get("online_status") or "all").strip()
        profiles, total = _get_json(
            "profiles",
            _profile_params(page, page_size, sort, direction, search, role, status, online_status),
            prefer_count=True,
        )
        user_ids = [str(profile.get("user_id")) for profile in profiles if isinstance(profile, dict) and profile.get("user_id")]
        banner_candidate_profiles = _fetch_banner_candidate_profiles()
        visibility_ids = list(dict.fromkeys([*user_ids, *banner_candidate_profiles.keys(), USER_ZERO_ID]))
        visibility_by_user = _fetch_visibility(visibility_ids)
        usage_by_user = _usage_stats_map(user_ids)
        invitations_by_inviter = _fetch_invitations_by_inviter(user_ids)
        rows = [
            _user_row(
                profile,
                visibility_by_user.get(str(profile.get("user_id")), {}),
                banner_candidate_profiles,
                visibility_by_user,
                usage_by_user.get(str(profile.get("user_id")), _empty_usage_stats()),
                invitations_by_inviter.get(str(profile.get("user_id")), []),
            )
            for profile in profiles
        ]
        if sort in {"messages_sent", "banner_count", "last_message_at"}:
            reverse = direction == "desc"
            if sort == "messages_sent":
                rows.sort(key=lambda row: row["usage"]["messages_sent"], reverse=reverse)
            elif sort == "banner_count":
                rows.sort(key=lambda row: row["visibility"]["active_banner_count"], reverse=reverse)
            elif sort == "last_message_at":
                rows.sort(key=lambda row: row["usage"]["last_message_at"] or "", reverse=reverse)
        return jsonify({
            "status": "ok",
            "mode": "read_only",
            "write_enabled": False,
            "timestamp": _now_iso(),
            "page": page,
            "page_size": page_size,
            "total": int(total or len(rows)),
            "sort": sort,
            "direction": direction,
            "filters": {"search": search, "role": role, "status": status, "online_status": online_status},
            "rows": rows,
        })
    except Exception as exc:
        return (
            jsonify({
                "status": "error",
                "mode": "read_only",
                "write_enabled": False,
                "message": f"User Operations probe failed: {type(exc).__name__}.",
                "timestamp": _now_iso(),
                "rows": [],
            }),
            502,
        )


@user_ops_bp.post("/api/console/users/avatar-url")
@require_capability("console.view_user_operations")
def user_operations_avatar_url():
    payload = request.get_json(silent=True) or {}
    avatar_path = str(payload.get("avatar_path") or "").strip()
    if not avatar_path:
        return jsonify({"status": "error", "message": "avatar_path is required."}), 400

    return jsonify({
        "status": "ok",
        "avatar_path": avatar_path,
        "avatar_url": _signed_avatar_url(avatar_path),
    })


# --- Unread / badge-offset diagnostics and controlled repair (Request 2086) -------
# The OS icon badge base observed on devices comes straight from the DB unread state:
# conversation_participants.unread_count feeds the in-app badge at startup, and the
# worker badge formula counts incoming messages with status<>'read' and is_read not
# true. These endpoints expose exactly those fields per conversation (read-only) and
# allow an audited owner repair/override for testing and clearing stale offsets.

UNREAD_REPAIR_MAX_CONVERSATIONS = 200


def _unread_message_filters(user_id: str, conversation_filter: str) -> dict[str, str]:
    return {
        "advisor_id": f"eq.{ADVISOR_ID}",
        "conversation_id": conversation_filter,
        "sender_id": f"neq.{user_id}",
        "status": "neq.read",
        "or": "(is_read.is.null,is_read.eq.false)",
    }


def _unread_diagnostics(user_id: str) -> dict:
    participant_rows, _total = _get_json(
        "conversation_participants",
        {"select": "conversation_id,unread_count", "user_id": f"eq.{user_id}", "limit": "2000"},
        timeout=12,
    )
    per_conversation: dict[str, dict] = {}
    for row in participant_rows:
        conversation_id = str(row.get("conversation_id") or "")
        if not conversation_id:
            continue
        per_conversation[conversation_id] = {
            "conversation_id": conversation_id,
            "unread_count": _to_int(row.get("unread_count")),
            "delivered_unread": 0,
            "stuck_sent": 0,
            "legacy_inconsistent": 0,
            "counterparts": [],
        }

    conversation_ids = list(per_conversation)
    if conversation_ids:
        message_rows, _mt = _get_json(
            "messages",
            {
                "select": "conversation_id,status,is_read",
                "advisor_id": f"eq.{ADVISOR_ID}",
                "conversation_id": f"in.({','.join(conversation_ids)})",
                "sender_id": f"neq.{user_id}",
                "status": "neq.read",
                "limit": "10000",
            },
            timeout=12,
        )
        for row in message_rows:
            conversation_id = str(row.get("conversation_id") or "")
            entry = per_conversation.get(conversation_id)
            if not entry:
                continue
            if bool(row.get("is_read")):
                entry["legacy_inconsistent"] += 1
            elif row.get("status") == "delivered":
                entry["delivered_unread"] += 1
            elif row.get("status") == "sent":
                entry["stuck_sent"] += 1

        try:
            other_rows, _ot = _get_json(
                "conversation_participants",
                {
                    "select": "conversation_id,user_id",
                    "conversation_id": f"in.({','.join(conversation_ids)})",
                    "user_id": f"neq.{user_id}",
                    "limit": "10000",
                },
                timeout=12,
            )
            other_ids = list({str(row.get("user_id")) for row in other_rows if row.get("user_id")})
            labels: dict[str, str] = {}
            if other_ids:
                profile_rows, _pt = _get_json(
                    "profiles",
                    {
                        "select": "user_id,email,full_name",
                        "advisor_id": f"eq.{ADVISOR_ID}",
                        "user_id": f"in.({','.join(other_ids)})",
                        "limit": "10000",
                    },
                    timeout=12,
                )
                labels = {
                    str(profile.get("user_id")): str(profile.get("full_name") or profile.get("email") or profile.get("user_id"))
                    for profile in profile_rows
                    if isinstance(profile, dict) and profile.get("user_id")
                }
            for row in other_rows:
                conversation_id = str(row.get("conversation_id") or "")
                other_id = str(row.get("user_id") or "")
                entry = per_conversation.get(conversation_id)
                if entry is not None and other_id:
                    entry["counterparts"].append(labels.get(other_id, other_id))
        except Exception:
            pass  # counterpart labels are cosmetic; diagnostics stay usable without them

    conversations = sorted(
        per_conversation.values(),
        key=lambda item: (item["unread_count"], item["delivered_unread"], item["stuck_sent"]),
        reverse=True,
    )
    totals = {
        "unread_count_total": sum(item["unread_count"] for item in conversations),
        "delivered_unread_total": sum(item["delivered_unread"] for item in conversations),
        "stuck_sent_total": sum(item["stuck_sent"] for item in conversations),
        "legacy_inconsistent_total": sum(item["legacy_inconsistent"] for item in conversations),
    }
    totals["worker_badge_formula_total"] = totals["delivered_unread_total"] + totals["stuck_sent_total"]
    return {"totals": totals, "conversations": conversations}


def _repair_unread_conversation(user_id: str, conversation_id: str, action: str, value: int | None) -> dict:
    if action == "set_unread":
        rows = _patch_json(
            "conversation_participants",
            {"conversation_id": f"eq.{conversation_id}", "user_id": f"eq.{user_id}"},
            {"unread_count": int(value or 0)},
        )
        return {"conversation_id": conversation_id, "action": action, "participant_rows": len(rows), "messages_marked_read": 0}

    # mark_read_and_sync: mark stuck incoming messages read, then zero the counter so
    # both badge sources (participants counter + worker message formula) agree.
    marked = _patch_json(
        "messages",
        _unread_message_filters(user_id, f"eq.{conversation_id}"),
        {"status": "read", "is_read": True, "read_at": _now_iso()},
    )
    participant_rows = _patch_json(
        "conversation_participants",
        {"conversation_id": f"eq.{conversation_id}", "user_id": f"eq.{user_id}"},
        {"unread_count": 0},
    )
    return {
        "conversation_id": conversation_id,
        "action": action,
        "messages_marked_read": len(marked),
        "participant_rows": len(participant_rows),
    }


@user_ops_bp.get("/api/console/users/<user_id>/unread-diagnostics")
@require_capability("console.view_user_operations")
def user_operations_unread_diagnostics(user_id: str):
    if not UUID_PATTERN.match(str(user_id or "")):
        return jsonify({"status": "error", "message": "user_id must be a UUID-like value."}), 400
    try:
        diagnostics = _unread_diagnostics(str(user_id))
    except Exception as exc:
        return jsonify({"status": "error", "message": f"Unread diagnostics failed: {type(exc).__name__}."}), 502
    return jsonify({"status": "ok", "mode": "read_only", "timestamp": _now_iso(), "user_id": str(user_id), **diagnostics})


@user_ops_bp.post("/api/console/users/repair-unread")
@require_capability("console.repair_user_operations")
def user_operations_repair_unread():
    payload = request.get_json(silent=True) or {}
    user_id = str(payload.get("user_id") or "").strip()
    conversation_id = str(payload.get("conversation_id") or "").strip()
    action = str(payload.get("action") or "").strip()
    confirmation = str(payload.get("confirmation") or "").strip().upper()
    raw_value = payload.get("value")

    if confirmation != "REPAIR":
        return jsonify({"status": "error", "message": "confirmation must be REPAIR."}), 400
    if not UUID_PATTERN.match(user_id):
        return jsonify({"status": "error", "message": "user_id must be a UUID-like value."}), 400
    if action not in {"mark_read_and_sync", "set_unread"}:
        return jsonify({"status": "error", "message": "action must be mark_read_and_sync or set_unread."}), 400
    if conversation_id != "all" and not UUID_PATTERN.match(conversation_id):
        return jsonify({"status": "error", "message": "conversation_id must be a UUID or 'all'."}), 400
    if action == "set_unread":
        if conversation_id == "all":
            return jsonify({"status": "error", "message": "set_unread needs a single conversation_id."}), 400
        value = _to_int(raw_value, -1)
        if value < 0 or value > 999:
            return jsonify({"status": "error", "message": "value must be an integer between 0 and 999."}), 400
    else:
        value = None

    actor = resolve_actor(request)
    try:
        if conversation_id == "all":
            participant_rows, _total = _get_json(
                "conversation_participants",
                {"select": "conversation_id", "user_id": f"eq.{user_id}", "limit": str(UNREAD_REPAIR_MAX_CONVERSATIONS)},
                timeout=12,
            )
            target_conversations = [str(row.get("conversation_id")) for row in participant_rows if row.get("conversation_id")]
            results = [_repair_unread_conversation(user_id, target, action, value) for target in target_conversations]
        else:
            results = [_repair_unread_conversation(user_id, conversation_id, action, value)]
        diagnostics = _unread_diagnostics(user_id)
    except Exception as exc:
        return jsonify({"status": "error", "message": f"Unread repair failed: {type(exc).__name__}."}), 502

    audit_event = {
        "event": "user_operations.repair_unread",
        "actor_email": actor.email,
        "actor_user_id": actor.user_id,
        "target_user_id": user_id,
        "conversation_id": conversation_id,
        "action": action,
        "value": value,
        "repaired_conversations": len(results),
        "timestamp": _now_iso(),
    }
    logger.warning("[AdminConsoleAudit] %s", json.dumps(audit_event, sort_keys=True))

    return jsonify({
        "status": "ok",
        "mode": "controlled_write",
        "write_enabled": True,
        "audit": audit_event,
        "results": results,
        **diagnostics,
    })


@user_ops_bp.post("/api/console/users/repair-active-banner")
@require_capability("console.repair_user_operations")
def user_operations_repair_active_banner():
    payload = request.get_json(silent=True) or {}
    owner_user_id = str(payload.get("owner_user_id") or "").strip()
    counterpart_user_id = str(payload.get("counterpart_user_id") or "").strip()
    confirmation = str(payload.get("confirmation") or "").strip().upper()
    reason = str(payload.get("reason") or "user_operations_drag_drop_repair").strip()[:160]

    if confirmation != "REPAIR":
        return jsonify({"status": "error", "message": "confirmation must be REPAIR."}), 400
    if not UUID_PATTERN.match(owner_user_id) or not UUID_PATTERN.match(counterpart_user_id):
        return jsonify({"status": "error", "message": "owner_user_id and counterpart_user_id must be UUID-like values."}), 400

    actor = resolve_actor(request)
    try:
        result = _repair_active_list_target(owner_user_id, counterpart_user_id)
    except (LookupError, ValueError) as exc:
        return jsonify({"status": "error", "message": str(exc)}), 400
    except Exception as exc:
        return jsonify({"status": "error", "message": f"Repair failed: {type(exc).__name__}."}), 502

    audit_event = {
        "event": "user_operations.repair_active_banner",
        "actor_email": actor.email,
        "actor_user_id": actor.user_id,
        "owner_user_id": owner_user_id,
        "counterpart_user_id": counterpart_user_id,
        "reason": reason,
        "timestamp": _now_iso(),
    }
    logger.warning("[AdminConsoleAudit] %s", json.dumps(audit_event, sort_keys=True))

    return jsonify({
        "status": "ok",
        "mode": "controlled_write",
        "write_enabled": True,
        "audit": audit_event,
        "repair": result,
    })
