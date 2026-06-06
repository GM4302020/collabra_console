# FILE: ~/otmega/otmega_app/console/admin_backend/admin_api/capabilities.py
# ماموریت: تعریف capabilityها، نقش ها و قواعد تفویض دسترسی Admin Console.

READ_ONLY_CAPABILITIES = (
    "console.view_health",
    "console.view_session",
    "console.view_runtime_inventory",
    "console.view_ui_texts_matrix",
    "console.use_ui_texts_ai_suggestions",
    "console.apply_ui_texts_matrix",
    "console.view_trace_summary",
    "console.view_audit",
    "console.view_real_profile",
    "console.view_operational_status",
    "console.view_gcs_browser",
    "console.use_transcript_api",
)


def capabilities_for_actor(actor) -> list[str]:
    if actor.is_user_zero:
        return list(READ_ONLY_CAPABILITIES)
    if actor.role in {"s_admin", "admin"}:
        return [
            "console.view_health",
            "console.view_session",
            "console.view_runtime_inventory",
            "console.view_ui_texts_matrix",
            "console.view_trace_summary",
            "console.view_real_profile",
            "console.view_operational_status",
        ]
    if actor.authenticated:
        return ["console.view_health", "console.view_session"]
    return ["console.view_health"]
