# FILE: ~/otmega/otmega_app/console/admin_backend/admin_api/profile_adapter.py
# ماموریت: خواندن read-only پروفایل واقعی Collabra و ساخت payload سازگار با MUPO کنسول.

import datetime
import json
import os
import urllib.parse
import urllib.request


ADVISOR_ID = int(os.environ.get("CONSOLE_ADVISOR_ID", "20018"))
PROFILE_SELECT = (
    "user_id,advisor_id,email,full_name,role,tier,balance,country_code,"
    "avatar_path,online_status,last_typed_lang,joined_at"
)
USER_ZERO_ID = "9197bacb-2387-4639-814f-9d643bbfb245"


def _format_balance(value) -> str:
    try:
        return f"{float(value):.2f}"
    except (TypeError, ValueError):
        return "0.00"


def _to_int(value, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _role_label(role: str | None, is_user_zero: bool) -> str:
    if is_user_zero:
        return "User Zero"
    normalized = (role or "guest").strip().lower()
    labels = {
        "s_admin": "S Admin",
        "admin": "Admin",
        "staff": "Staff",
        "customer": "Customer",
        "guest": "Guest",
        "service_role": "Service Role",
    }
    return labels.get(normalized, normalized.replace("_", " ").title())


def _avatar_path_candidates(avatar_path: str) -> list[str]:
    normalized = avatar_path.strip().lstrip("/")
    candidates = []
    if normalized.endswith(".png"):
        candidates.append(normalized[:-4] + ".webp")
    candidates.append(normalized)
    if normalized.startswith("assets/users/"):
        rooted = f"advisors/collabra-{ADVISOR_ID}-v1.0.0/{normalized}"
        if rooted.endswith(".png"):
            candidates.insert(0, rooted[:-4] + ".webp")
        candidates.append(rooted)
    return list(dict.fromkeys(candidates))


def _signed_avatar_url(avatar_path: str | None) -> str | None:
    if not avatar_path:
        return None
    if avatar_path.startswith("https://"):
        return avatar_path
    try:
        from google.cloud import storage

        bucket_name = os.environ.get("APP_DATA_BUCKET_NAME", "otmega-collabra-secure")
        storage_client = storage.Client()
        bucket = storage_client.bucket(bucket_name)
        candidates = _avatar_path_candidates(avatar_path)
        selected_blob = None
        for candidate in candidates:
            candidate_blob = bucket.blob(candidate)
            if candidate_blob.exists(client=storage_client):
                selected_blob = candidate_blob
                break
        blob = selected_blob or bucket.blob(candidates[0])
        signed_url = blob.generate_signed_url(
            version="v4",
            expiration=datetime.timedelta(hours=12),
            method="GET",
        )
        return signed_url.replace("storage.googleapis.com", "files.otmega.com")
    except Exception:
        return None


def _rest_headers() -> dict[str, str] | None:
    service_role_key = os.environ.get("PRG2_SUPABASE_SERVICE_ROLE_KEY")
    if not service_role_key:
        return None
    return {
        "Accept": "application/json",
        "apikey": service_role_key,
        "Authorization": f"Bearer {service_role_key}",
    }


def _fetch_profile_by_filter(filter_key: str, filter_value: str | None) -> dict | None:
    supabase_url = (os.environ.get("PRG2_SUPABASE_URL") or "").rstrip("/")
    headers = _rest_headers()
    if not supabase_url or not headers or not filter_value:
        return None

    query = urllib.parse.urlencode(
        {
            "select": PROFILE_SELECT,
            filter_key: f"eq.{filter_value}",
            "advisor_id": f"eq.{ADVISOR_ID}",
            "limit": "1",
        },
        safe=",().",
    )
    request = urllib.request.Request(f"{supabase_url}/rest/v1/profiles?{query}", headers=headers, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            rows = json.loads(response.read().decode("utf-8"))
    except Exception:
        return None

    if isinstance(rows, list) and rows and isinstance(rows[0], dict):
        return rows[0]
    return None


def load_console_profile(email: str, fallback_user_id: str | None = None) -> dict | None:
    normalized_email = (email or "").strip().lower()
    profile = _fetch_profile_by_filter("user_id", fallback_user_id)
    if profile is None:
        profile = _fetch_profile_by_filter("email", normalized_email)
    if profile is None:
        profile = _fetch_profile_by_filter("user_id", os.environ.get("CONSOLE_USER_ZERO_ID", USER_ZERO_ID))
    if profile is None:
        return None

    user_id = profile.get("user_id") or fallback_user_id or USER_ZERO_ID
    role = profile.get("role") or "guest"
    is_user_zero = user_id == os.environ.get("CONSOLE_USER_ZERO_ID", USER_ZERO_ID)
    avatar_url = _signed_avatar_url(profile.get("avatar_path"))
    full_name = profile.get("full_name") or normalized_email or "Console operator"

    return {
        "authenticated": True,
        "bearer_present": False,
        "user_id": user_id,
        "email": profile.get("email") or normalized_email,
        "full_name": full_name,
        "title": profile.get("email") or normalized_email,
        "avatar_url": avatar_url,
        "avatar_path": profile.get("avatar_path"),
        "balance": _format_balance(profile.get("balance")),
        "country_code": (profile.get("country_code") or "us"),
        "online_status": profile.get("online_status") or "offline",
        "last_typed_lang": profile.get("last_typed_lang") or "en",
        "tier": _to_int(profile.get("tier"), 0),
        "role": "user_zero" if is_user_zero else role,
        "access_level": _role_label(role, is_user_zero),
        "is_user_zero": is_user_zero,
        "profile_source": "profiles",
        "advisor_id": profile.get("advisor_id") or ADVISOR_ID,
    }
