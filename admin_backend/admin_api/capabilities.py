# FILE: ~/otmega/otmega_app/console/admin_backend/admin_api/capabilities.py
# ماموریت: تعریف capabilityها، نقش ها و قواعد تفویض دسترسی Admin Console.

READ_ONLY_CAPABILITIES = (
    "console.view_health",
    "console.view_session",
    "console.view_runtime_inventory",
    "console.view_trace_summary",
)


def capabilities_for_actor(actor) -> list[str]:
    if actor.is_user_zero:
        return list(READ_ONLY_CAPABILITIES)
    if actor.authenticated:
        return ["console.view_health", "console.view_session"]
    return ["console.view_health"]
