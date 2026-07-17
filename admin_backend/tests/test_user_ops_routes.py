# FILE: ~/otmega/otmega_app/console/admin_backend/tests/test_user_ops_routes.py
# ماموریت: تست API read-only فهرست عملیاتی کاربران بدون اتصال واقعی به Supabase.

from app import create_app
from admin_api import user_ops_routes


def test_user_operations_returns_enriched_rows(monkeypatch):
    monkeypatch.setenv("FALLBACK_ADMIN_USER", "root@example.com")
    monkeypatch.setenv("FALLBACK_ADMIN_PASS", "correct-pass")

    def fake_get_json(table, params, prefer_count=False, timeout=12):
        if table == "profiles" and params.get("select", "").startswith("user_id,advisor_id,email"):
            return (
                [
                    {
                        "user_id": "user-1",
                        "advisor_id": 20018,
                        "email": "one@example.com",
                        "full_name": "User One",
                        "role": "customer",
                        "tier": 3,
                        "balance": "12.50",
                        "country_code": "us",
                        "avatar_path": None,
                        "online_status": "online",
                        "last_typed_lang": "en",
                        "joined_at": "2026-06-21T10:00:00Z",
                        "status": "active",
                        "fcm_tokens": {"device": "long-valid-fcm-token-value", "session": "abc"},
                    }
                ],
                1,
            )
        if table == "profile_visibility_settings":
            return (
                [
                    {
                        "user_id": "user-1",
                        "profile_visibility": "public",
                        "updated_at": "2026-06-21T11:00:00Z",
                        "visibility_changed_at": "2026-06-21T11:00:00Z",
                        "visibility_rules": {"active_list_targets": ["user-2"], "removed_from_list_targets": []},
                    }
                ],
                None,
            )
        if table == "profiles" and params.get("select", "").startswith("user_id,email"):
            return (
                [
                    {"user_id": user_ops_routes.ADVISOR_USER_ID, "email": "advisor@example.com", "full_name": "Advisor", "online_status": "online", "is_bot": True},
                    {"user_id": "user-2", "email": "two@example.com", "full_name": "User Two", "avatar_path": "assets/users/user-2/avatar.webp", "online_status": "away", "is_bot": False},
                    {"user_id": "user-3", "email": "three@example.com", "full_name": "User Three", "online_status": "offline", "is_bot": False},
                    {"user_id": "user-4", "email": "admin@example.com", "full_name": "Admin Four", "online_status": "offline", "role": "s_admin", "is_bot": False},
                ],
                None,
            )
        if table == "messages":
            return (
                [
                    {"sender_id": "user-1", "created_at": "2026-06-21T12:00:00Z"},
                    {"sender_id": "user-1", "created_at": "2026-06-21T11:00:00Z"},
                ],
                None,
            )
        if table == "conversation_participants" and "user_id" in params:
            return (
                [
                    {"user_id": "user-1", "conversation_id": "conv-1", "unread_count": 2},
                    {"user_id": "user-1", "conversation_id": "conv-2", "unread_count": 0},
                ],
                None,
            )
        if table == "conversation_participants" and "conversation_id" in params:
            return (
                [
                    {"user_id": "user-1", "conversation_id": "conv-1"},
                    {"user_id": "user-3", "conversation_id": "conv-1"},
                    {"user_id": "user-1", "conversation_id": "conv-2"},
                    {"user_id": "user-4", "conversation_id": "conv-2"},
                ],
                None,
            )
        if table == "conversations":
            return (
                [
                    {"id": "conv-1", "status": "active", "last_message_at": "2026-06-21T12:00:00Z"},
                    {"id": "conv-2", "status": "active", "last_message_at": "2026-06-21T12:05:00Z"},
                ],
                None,
            )
        if table == "message_notify_dedupe":
            return (
                [
                    {"recipient_user_id": "user-1", "route_selected": "push"},
                    {"recipient_user_id": "user-1", "route_selected": "internal"},
                ],
                None,
            )
        return ([], 0)

    monkeypatch.setattr(user_ops_routes, "_get_json", fake_get_json)
    monkeypatch.setattr(user_ops_routes, "_signed_avatar_url", lambda path: f"https://files.example/{path}" if path else None)

    app = create_app()
    app.config["TESTING"] = True
    client = app.test_client()
    client.post("/api/console/login", json={"email": "root@example.com", "password": "correct-pass"})

    response = client.get("/api/console/users/operations?page_size=10")
    payload = response.get_json()

    assert response.status_code == 200
    assert payload["mode"] == "read_only"
    assert payload["write_enabled"] is False
    assert payload["total"] == 1
    row = payload["rows"][0]
    assert row["email"] == "one@example.com"
    assert row["usage"]["messages_sent"] == 2
    assert row["usage"]["conversations"]["active_with_chat"] == 2
    assert row["usage"]["conversations"]["banner_list_with_chat"] == 1
    assert row["usage"]["conversations"]["upstream_system_with_chat"] == 1
    assert row["visibility"]["active_banner_count"] == 3
    assert row["visibility"]["stored_active_relation_count"] == 1
    assert row["visibility"]["chat_banner_count"] == 1
    assert row["visibility"]["upstream_system_banner_count"] == 1
    assert row["visibility"]["required_banner_count"] == 2
    assert row["visibility"]["warmable_chat_count"] == 2
    assert [target["email"] for target in row["visibility"]["visible_now_targets"] if target["email"]] == [
        "advisor@example.com",
        "guest-system-20018@otmega.internal",
        "two@example.com",
    ]
    assert row["visibility"]["visible_now_targets"][2]["avatar_path"] == "assets/users/user-2/avatar.webp"
    assert "avatar_url" not in row["visibility"]["visible_now_targets"][2]
    assert [target["email"] for target in row["visibility"]["warmable_chat_targets"] if target["email"]] == [
        "three@example.com",
        "admin@example.com",
    ]
    warmable_by_email = {target["email"]: target for target in row["visibility"]["warmable_chat_targets"] if target["email"]}
    assert warmable_by_email["three@example.com"]["repairable"] is True
    assert warmable_by_email["admin@example.com"]["repairable"] is False
    assert warmable_by_email["admin@example.com"]["repair_block_reason"] == "privileged_policy_managed"
    assert row["notifications"]["system_notification_tokens"] == 1
    assert row["usage"]["notifications"]["system_push_total"] == 1


def test_user_operations_page_size_50_uses_batch_stats(monkeypatch):
    monkeypatch.setenv("FALLBACK_ADMIN_USER", "root@example.com")
    monkeypatch.setenv("FALLBACK_ADMIN_PASS", "correct-pass")
    calls = []
    profiles = [
        {
            "user_id": f"00000000-0000-0000-0000-0000000000{index:02d}",
            "advisor_id": 20018,
            "email": f"user{index}@example.com",
            "full_name": f"User {index}",
            "role": "guest",
            "tier": 0,
            "balance": "0",
            "avatar_path": None,
            "online_status": "offline",
            "joined_at": "2026-06-21T10:00:00Z",
            "status": "active",
            "fcm_tokens": {},
        }
        for index in range(50)
    ]

    def fake_get_json(table, params, prefer_count=False, timeout=12):
        calls.append((table, params))
        if table == "profiles" and params.get("select", "").startswith("user_id,advisor_id,email"):
            return (profiles, 50)
        if table == "profiles" and params.get("select", "").startswith("user_id,email"):
            return ([], 0)
        if table in {"profile_visibility_settings", "messages", "conversation_participants", "conversations", "message_notify_dedupe"}:
            return ([], 0)
        return ([], 0)

    monkeypatch.setattr(user_ops_routes, "_get_json", fake_get_json)
    monkeypatch.setattr(user_ops_routes, "_signed_avatar_url", lambda path: None)

    app = create_app()
    app.config["TESTING"] = True
    client = app.test_client()
    client.post("/api/console/login", json={"email": "root@example.com", "password": "correct-pass"})

    response = client.get("/api/console/users/operations?page_size=50")
    payload = response.get_json()

    assert response.status_code == 200
    assert len(payload["rows"]) == 50
    assert len([table for table, _params in calls if table == "messages"]) == 1
    assert len([table for table, _params in calls if table == "conversation_participants"]) == 1
    assert len([table for table, _params in calls if table == "message_notify_dedupe"]) == 1


def test_user_operations_avatar_url_uses_avatar_signer(monkeypatch):
    monkeypatch.setenv("FALLBACK_ADMIN_USER", "root@example.com")
    monkeypatch.setenv("FALLBACK_ADMIN_PASS", "correct-pass")
    monkeypatch.setattr(user_ops_routes, "_signed_avatar_url", lambda path: f"https://files.example/{path}" if path else None)

    app = create_app()
    app.config["TESTING"] = True
    client = app.test_client()
    client.post("/api/console/login", json={"email": "root@example.com", "password": "correct-pass"})

    response = client.post("/api/console/users/avatar-url", json={"avatar_path": "assets/users/u/avatar.webp"})
    payload = response.get_json()

    assert response.status_code == 200
    assert payload["avatar_url"] == "https://files.example/assets/users/u/avatar.webp"


def test_user_operations_repair_active_banner_patches_owner_rules(monkeypatch):
    monkeypatch.setenv("FALLBACK_ADMIN_USER", "root@example.com")
    monkeypatch.setenv("FALLBACK_ADMIN_PASS", "correct-pass")
    written = {}
    owner_id = "11111111-1111-4111-8111-111111111111"
    target_id = "22222222-2222-4222-8222-222222222222"

    def fake_get_json(table, params, prefer_count=False, timeout=12):
        if table == "profiles":
            user_id = str(params.get("user_id", "")).replace("eq.", "")
            profile = {
                owner_id: {
                    "user_id": owner_id,
                    "advisor_id": 20018,
                    "email": "owner@example.com",
                    "full_name": "Owner User",
                    "role": "guest",
                },
                target_id: {
                    "user_id": target_id,
                    "advisor_id": 20018,
                    "email": "target@example.com",
                    "full_name": "Target User",
                    "role": "customer",
                },
            }.get(user_id)
            return ([profile], None) if profile else ([], None)
        if table == "profile_visibility_settings":
            return (
                [
                    {
                        "user_id": owner_id,
                        "advisor_id": 20018,
                        "visibility_rules": {
                            "active_list_targets": {},
                            "removed_from_list_targets": {target_id: True},
                            "hidden_in_search_viewers": {"someone": True},
                        },
                    }
                ],
                None,
            )
        return ([], None)

    def fake_patch_json(table, filters, payload, timeout=12):
        written["table"] = table
        written["filters"] = filters
        written["payload"] = payload
        return [{"user_id": owner_id}]

    monkeypatch.setattr(user_ops_routes, "_get_json", fake_get_json)
    monkeypatch.setattr(user_ops_routes, "_patch_json", fake_patch_json)

    app = create_app()
    app.config["TESTING"] = True
    client = app.test_client()
    client.post("/api/console/login", json={"email": "root@example.com", "password": "correct-pass"})

    response = client.post(
        "/api/console/users/repair-active-banner",
        json={
            "owner_user_id": owner_id,
            "counterpart_user_id": target_id,
            "confirmation": "REPAIR",
        },
    )
    payload = response.get_json()
    next_rules = written["payload"]["visibility_rules"]

    assert response.status_code == 200
    assert payload["write_enabled"] is True
    assert written["table"] == "profile_visibility_settings"
    assert target_id in next_rules["active_list_targets"]
    assert "removed_from_list_targets" not in next_rules
    assert next_rules["hidden_in_search_viewers"] == {"someone": True}


def test_user_operations_repair_active_banner_rejects_privileged_counterpart(monkeypatch):
    monkeypatch.setenv("FALLBACK_ADMIN_USER", "root@example.com")
    monkeypatch.setenv("FALLBACK_ADMIN_PASS", "correct-pass")
    owner_id = "11111111-1111-4111-8111-111111111111"
    target_id = "22222222-2222-4222-8222-222222222222"

    def fake_get_json(table, params, prefer_count=False, timeout=12):
        if table == "profiles":
            user_id = str(params.get("user_id", "")).replace("eq.", "")
            profile = {
                owner_id: {
                    "user_id": owner_id,
                    "advisor_id": 20018,
                    "email": "owner@example.com",
                    "full_name": "Owner User",
                    "role": "guest",
                },
                target_id: {
                    "user_id": target_id,
                    "advisor_id": 20018,
                    "email": "admin@example.com",
                    "full_name": "Admin User",
                    "role": "s_admin",
                },
            }.get(user_id)
            return ([profile], None) if profile else ([], None)
        if table == "profile_visibility_settings":
            return ([{"user_id": owner_id, "advisor_id": 20018, "visibility_rules": {}}], None)
        return ([], None)

    monkeypatch.setattr(user_ops_routes, "_get_json", fake_get_json)

    app = create_app()
    app.config["TESTING"] = True
    client = app.test_client()
    client.post("/api/console/login", json={"email": "root@example.com", "password": "correct-pass"})

    response = client.post(
        "/api/console/users/repair-active-banner",
        json={
            "owner_user_id": owner_id,
            "counterpart_user_id": target_id,
            "confirmation": "REPAIR",
        },
    )
    payload = response.get_json()

    assert response.status_code == 400
    assert "privileged_policy_managed" in payload["message"]


def test_user_operations_count_rows_does_not_require_id_column(monkeypatch):
    seen_params = []

    def fake_get_json(table, params, prefer_count=False, timeout=12):
        seen_params.append(params)
        return ([], 3)

    monkeypatch.setattr(user_ops_routes, "_get_json", fake_get_json)

    assert user_ops_routes._count_rows("message_notify_dedupe", {"recipient_user_id": "eq.user-1"}) == 3
    assert seen_params[0]["select"] == "*"
    assert seen_params[0]["limit"] == "0"


def test_profile_params_keeps_computed_sort_client_side():
    params = user_ops_routes._profile_params(
        page=1,
        page_size=25,
        sort="messages_sent",
        direction="desc",
        search="",
        role="all",
        status="all",
        online_status="all",
    )

    assert params["order"] == "joined_at.desc,user_id.desc"


def test_unread_diagnostics_aggregates_badge_sources(monkeypatch):
    def fake_get_json(table, params, prefer_count=False, timeout=12):
        if table == "conversation_participants" and params.get("select") == "conversation_id,unread_count":
            return ([
                {"conversation_id": "conv-1", "unread_count": 2},
                {"conversation_id": "conv-2", "unread_count": 0},
            ], None)
        if table == "messages":
            return ([
                {"conversation_id": "conv-1", "status": "delivered", "is_read": False},
                {"conversation_id": "conv-1", "status": "delivered", "is_read": False},
                {"conversation_id": "conv-2", "status": "sent", "is_read": False},
                {"conversation_id": "conv-2", "status": "delivered", "is_read": True},
            ], None)
        if table == "conversation_participants" and params.get("select") == "conversation_id,user_id":
            return ([
                {"conversation_id": "conv-1", "user_id": "other-1"},
                {"conversation_id": "conv-2", "user_id": "other-2"},
            ], None)
        if table == "profiles":
            return ([
                {"user_id": "other-1", "email": "o1@example.com", "full_name": "Other One"},
            ], None)
        return ([], None)

    monkeypatch.setattr(user_ops_routes, "_get_json", fake_get_json)

    diagnostics = user_ops_routes._unread_diagnostics("user-1")

    assert diagnostics["totals"] == {
        "unread_count_total": 2,
        "delivered_unread_total": 2,
        "stuck_sent_total": 1,
        "legacy_inconsistent_total": 1,
        "worker_badge_formula_total": 3,
    }
    by_id = {item["conversation_id"]: item for item in diagnostics["conversations"]}
    assert by_id["conv-1"]["delivered_unread"] == 2
    assert by_id["conv-1"]["counterparts"] == ["Other One"]
    assert by_id["conv-2"]["stuck_sent"] == 1
    assert by_id["conv-2"]["legacy_inconsistent"] == 1


def test_repair_unread_conversation_marks_read_and_zeroes(monkeypatch):
    patched = []

    def fake_patch_json(table, filters, payload, timeout=12):
        patched.append((table, filters, payload))
        return [{"ok": True}]

    monkeypatch.setattr(user_ops_routes, "_patch_json", fake_patch_json)

    result = user_ops_routes._repair_unread_conversation("user-1", "conv-1", "mark_read_and_sync", None)

    assert result["messages_marked_read"] == 1
    assert result["participant_rows"] == 1
    message_patch = patched[0]
    assert message_patch[0] == "messages"
    assert message_patch[1]["status"] == "neq.read"
    assert message_patch[1]["or"] == "(is_read.is.null,is_read.eq.false)"
    assert message_patch[2]["status"] == "read"
    assert message_patch[2]["is_read"] is True
    participant_patch = patched[1]
    assert participant_patch[0] == "conversation_participants"
    assert participant_patch[2] == {"unread_count": 0}


def test_repair_unread_set_value(monkeypatch):
    patched = []

    def fake_patch_json(table, filters, payload, timeout=12):
        patched.append((table, filters, payload))
        return [{"ok": True}]

    monkeypatch.setattr(user_ops_routes, "_patch_json", fake_patch_json)

    result = user_ops_routes._repair_unread_conversation("user-1", "conv-1", "set_unread", 5)

    assert result["participant_rows"] == 1
    assert patched[0][0] == "conversation_participants"
    assert patched[0][2] == {"unread_count": 5}
