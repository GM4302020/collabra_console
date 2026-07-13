# FILE: ~/otmega/otmega_app/console/admin_backend/admin_api/devlog_routes.py
# ماموریت: مدیریت caseهای DevLog، شمارش معکوس، artifact و exportهای استاندارد در مسیر main-data روی GCS.

from __future__ import annotations

import csv
import datetime as dt
import html as html_lib
import io
import json
import os
import re
import statistics
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any

from flask import Blueprint, Response, jsonify, request
from google.cloud import storage
from werkzeug.utils import secure_filename

from admin_api.auth import resolve_actor
from admin_api.guards import require_capability


devlog_bp = Blueprint("console_devlog", __name__)

BUCKET_NAME = os.environ.get("APP_DATA_BUCKET_NAME", "otmega-collabra-secure")
DEBUG_CASES_ROOT = "advisors/collabra-20018-v1.0.0/main-data/debug-cases"
MAX_CAPTURE_MINUTES = 24 * 60
DEFAULT_CAPTURE_MINUTES = 30
DEFAULT_RETENTION_DAYS = 7
MAX_RETENTION_DAYS = 30
MAX_EXPORT_EVENTS = 10_000
MAX_ARTIFACT_BYTES = 12 * 1024 * 1024
ALLOWED_ARTIFACT_EXTENSIONS = {"png", "jpg", "jpeg", "webp", "gif", "pdf", "txt", "md", "json"}
ADVISOR_ID = int(os.environ.get("CONSOLE_ADVISOR_ID") or os.environ.get("COLLABRA_ADVISOR_ID") or "20018")

_storage_client: storage.Client | None = None
_CASE_ID_RE = re.compile(r"^[a-zA-Z0-9_-]{8,96}$")
_USER_ID_RE = re.compile(r"^[0-9a-fA-F-]{32,40}$")


def _storage() -> storage.Client:
    global _storage_client
    if _storage_client is None:
        _storage_client = storage.Client()
    return _storage_client


def _utc_now() -> dt.datetime:
    return dt.datetime.now(dt.UTC)


def _utc_iso(value: dt.datetime | None = None) -> str:
    return (value or _utc_now()).isoformat().replace("+00:00", "Z")


def _parse_utc(value: Any) -> dt.datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = dt.datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.UTC)
    return parsed.astimezone(dt.UTC)


def _bounded_int(value: Any, default: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    return max(minimum, min(maximum, parsed))


def _safe_segment(value: Any, fallback: str = "unknown", maximum: int = 120) -> str:
    normalized = re.sub(r"[^a-zA-Z0-9_.-]+", "_", str(value or "").strip())[:maximum]
    return normalized or fallback


def _case_prefix(case_id: str) -> str:
    normalized = str(case_id or "").strip()
    if not _CASE_ID_RE.fullmatch(normalized):
        raise ValueError("Invalid DevLog case id.")
    return f"{DEBUG_CASES_ROOT}/{normalized}"


def _active_pointer_path(user_id: str) -> str:
    return f"{DEBUG_CASES_ROOT}/active-users/{_safe_segment(user_id, maximum=80)}.json"


def _read_json(path: str) -> dict[str, Any] | None:
    blob = _storage().bucket(BUCKET_NAME).blob(path)
    if not blob.exists():
        return None
    try:
        payload = json.loads(blob.download_as_text(encoding="utf-8"))
    except (ValueError, TypeError):
        return None
    return payload if isinstance(payload, dict) else None


def _write_json(path: str, payload: dict[str, Any]) -> None:
    _storage().bucket(BUCKET_NAME).blob(path).upload_from_string(
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True),
        content_type="application/json",
    )


def _manifest_path(case_id: str) -> str:
    return f"{_case_prefix(case_id)}/case.json"


def _read_manifest(case_id: str) -> dict[str, Any] | None:
    return _read_json(_manifest_path(case_id))


def _write_manifest(manifest: dict[str, Any]) -> None:
    manifest["updated_at"] = _utc_iso()
    _write_json(_manifest_path(str(manifest.get("case_id") or "")), manifest)


def _countdown_state(manifest: dict[str, Any]) -> dict[str, Any]:
    now = _utc_now()
    capture_expires_at = _parse_utc(manifest.get("capture_expires_at"))
    expires_at = _parse_utc(manifest.get("expires_at"))
    return {
        "capture_remaining_seconds": max(0, int((capture_expires_at - now).total_seconds())) if capture_expires_at else 0,
        "retention_started": bool(manifest.get("retention_started_at")),
        "retention_remaining_seconds": max(0, int((expires_at - now).total_seconds())) if expires_at else None,
        "expired": bool(expires_at and expires_at <= now),
        "label": (
            "expired"
            if expires_at and expires_at <= now
            else f"{max(0, int((expires_at - now).total_seconds()))} seconds remaining"
            if expires_at
            else "not started — download or start cleanup countdown"
        ),
    }


def _list_blobs(prefix: str):
    return list(_storage().list_blobs(BUCKET_NAME, prefix=prefix))


def _delete_case(case_id: str, user_id: str | None = None) -> None:
    for blob in _list_blobs(f"{_case_prefix(case_id)}/"):
        blob.delete()
    if user_id:
        pointer_blob = _storage().bucket(BUCKET_NAME).blob(_active_pointer_path(user_id))
        pointer = _read_json(_active_pointer_path(user_id))
        if pointer and pointer.get("case_id") == case_id and pointer_blob.exists():
            pointer_blob.delete()


def _cleanup_expired_cases() -> int:
    deleted = 0
    for blob in _list_blobs(f"{DEBUG_CASES_ROOT}/"):
        if not blob.name.endswith("/case.json"):
            continue
        try:
            manifest = json.loads(blob.download_as_text(encoding="utf-8"))
        except (ValueError, TypeError):
            continue
        if not isinstance(manifest, dict):
            continue
        expires_at = _parse_utc(manifest.get("expires_at"))
        case_id = str(manifest.get("case_id") or "")
        if expires_at and expires_at <= _utc_now() and _CASE_ID_RE.fullmatch(case_id):
            _delete_case(case_id, str(manifest.get("user_id") or "") or None)
            deleted += 1
    return deleted


def _case_summaries(user_id: str | None = None) -> list[dict[str, Any]]:
    summaries: list[dict[str, Any]] = []
    for blob in _list_blobs(f"{DEBUG_CASES_ROOT}/"):
        if not blob.name.endswith("/case.json"):
            continue
        try:
            manifest = json.loads(blob.download_as_text(encoding="utf-8"))
        except (ValueError, TypeError):
            continue
        if not isinstance(manifest, dict):
            continue
        if user_id and str(manifest.get("user_id") or "") != user_id:
            continue
        summaries.append({**manifest, "countdown": _countdown_state(manifest)})
    return sorted(summaries, key=lambda item: str(item.get("created_at") or ""), reverse=True)


def _load_case_events(case_id: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    events: list[dict[str, Any]] = []
    devices: dict[str, dict[str, Any]] = {}
    for blob in _list_blobs(f"{_case_prefix(case_id)}/events/")[:2_000]:
        if not blob.name.endswith(".json"):
            continue
        try:
            batch = json.loads(blob.download_as_text(encoding="utf-8"))
        except (ValueError, TypeError):
            continue
        if not isinstance(batch, dict):
            continue
        device = batch.get("device") if isinstance(batch.get("device"), dict) else {}
        device_ref = str(device.get("device_session_ref") or "unknown")
        devices[device_ref] = device
        for event in batch.get("events") or []:
            if isinstance(event, dict):
                events.append({**event, "device": device, "batch_path": blob.name})
                if len(events) >= MAX_EXPORT_EVENTS:
                    break
        if len(events) >= MAX_EXPORT_EVENTS:
            break
    events.sort(key=lambda item: str(item.get("server_received_at") or item.get("client_wall_at") or ""))
    return events, list(devices.values())


def _list_artifacts(case_id: str) -> list[dict[str, Any]]:
    artifacts = []
    for blob in _list_blobs(f"{_case_prefix(case_id)}/artifacts/"):
        artifacts.append({
            "path": blob.name,
            "name": blob.name.rsplit("/", 1)[-1],
            "size": int(blob.size or 0),
            "content_type": blob.content_type,
            "updated_at": blob.updated.isoformat().replace("+00:00", "Z") if blob.updated else None,
        })
    return artifacts


def _number(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed == parsed else None


def _rounded(value: float | None) -> float | None:
    return round(value, 2) if value is not None else None


def _latency_stats(values: list[float]) -> dict[str, Any]:
    normalized = sorted(values)
    if not normalized:
        return {"count": 0, "min_ms": None, "avg_ms": None, "median_ms": None, "p95_ms": None, "max_ms": None}
    p95_index = min(len(normalized) - 1, max(0, int((len(normalized) * 0.95) + 0.999999) - 1))
    return {
        "count": len(normalized),
        "min_ms": _rounded(normalized[0]),
        "avg_ms": _rounded(sum(normalized) / len(normalized)),
        "median_ms": _rounded(float(statistics.median(normalized))),
        "p95_ms": _rounded(normalized[p95_index]),
        "max_ms": _rounded(normalized[-1]),
    }


def _first_event(events: list[dict[str, Any]], code: str) -> dict[str, Any] | None:
    return next((event for event in events if event.get("event_code") == code), None)


def _mono_delta(start: dict[str, Any] | None, end: dict[str, Any] | None) -> float | None:
    start_value = _number((start or {}).get("client_mono_ms"))
    end_value = _number((end or {}).get("client_mono_ms"))
    return _rounded(end_value - start_value) if start_value is not None and end_value is not None else None


def _notification_latency_ms(row: dict[str, Any]) -> float | None:
    created_at = _parse_utc(row.get("created_at"))
    sent_at = _parse_utc(row.get("sent_at"))
    return _rounded((sent_at - created_at).total_seconds() * 1000) if created_at and sent_at else None


def _load_notification_evidence(events: list[dict[str, Any]]) -> dict[str, Any]:
    """Read Worker-written notification outcomes for canonical message ids; fail open."""
    message_ids = sorted({
        str(event.get("message_id") or "").strip()
        for event in events
        if _USER_ID_RE.fullmatch(str(event.get("message_id") or "").strip())
    })[:100]
    base_url = (os.environ.get("PRG2_SUPABASE_URL") or os.environ.get("SUPABASE_URL") or "").rstrip("/")
    service_key = os.environ.get("PRG2_SUPABASE_SERVICE_ROLE_KEY") or os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not message_ids:
        return {"available": True, "source": "message_notify_dedupe", "rows": [], "counts": {}, "reason_code": "no_canonical_message_ids"}
    if not base_url or not service_key:
        return {"available": False, "source": "message_notify_dedupe", "rows": [], "counts": {}, "reason_code": "supabase_read_not_configured"}

    params = {
        "select": "advisor_id,message_id,recipient_user_id,route_selected,notify_state,created_at,sent_at,attempts,last_attempt_at,last_error",
        "advisor_id": f"eq.{ADVISOR_ID}",
        "message_id": f"in.({','.join(message_ids)})",
        "order": "created_at.asc",
        "limit": "500",
    }
    query = urllib.parse.urlencode(params, safe=",().:*-_")
    req = urllib.request.Request(
        f"{base_url}/rest/v1/message_notify_dedupe?{query}",
        headers={"Accept": "application/json", "apikey": service_key, "Authorization": f"Bearer {service_key}"},
        method="GET",
    )
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=8) as response:
            payload = json.loads(response.read().decode("utf-8") or "[]")
    except (urllib.error.URLError, TimeoutError, ValueError, OSError) as exc:
        return {
            "available": False,
            "source": "message_notify_dedupe",
            "rows": [],
            "counts": {},
            "query_latency_ms": round((time.perf_counter() - started) * 1000),
            "reason_code": f"notification_evidence_read_failed:{type(exc).__name__}",
        }

    rows = []
    counts: dict[str, int] = {}
    for raw in payload if isinstance(payload, list) else []:
        if not isinstance(raw, dict):
            continue
        state = str(raw.get("notify_state") or "unknown")
        counts[state] = counts.get(state, 0) + 1
        last_error = str(raw.get("last_error") or "")
        rows.append({
            "advisor_id": raw.get("advisor_id"),
            "message_id": raw.get("message_id"),
            "recipient_user_id": raw.get("recipient_user_id"),
            "route_selected": raw.get("route_selected"),
            "notify_state": state,
            "created_at": raw.get("created_at"),
            "sent_at": raw.get("sent_at"),
            "attempts": raw.get("attempts"),
            "last_attempt_at": raw.get("last_attempt_at"),
            # Export a stable diagnostic category, not a potentially sensitive provider body.
            "last_error_code": last_error.split(":", 1)[0][:120] if last_error else None,
            "created_to_sent_ms": _notification_latency_ms(raw),
        })
    return {
        "available": True,
        "source": "message_notify_dedupe",
        "queried_at": _utc_iso(),
        "query_latency_ms": round((time.perf_counter() - started) * 1000),
        "rows": rows,
        "counts": dict(sorted(counts.items())),
        "reason_code": None if rows else "no_matching_worker_outcome",
    }


def _collector_ingest_delay_stats(events: list[dict[str, Any]]) -> dict[str, Any]:
    values: list[float] = []
    for event in events:
        client_at = _parse_utc(event.get("client_wall_at"))
        server_at = _parse_utc(event.get("server_received_at"))
        if not client_at or not server_at:
            continue
        value = (server_at - client_at).total_seconds() * 1000
        if -3_600_000 <= value <= 3_600_000:
            values.append(value)
    return {
        **_latency_stats(values),
        "interpretation": "Wall-clock estimate of batching/collector arrival; clock skew may contribute and this is not message latency.",
    }


def _analysis_ms(value: Any) -> str:
    parsed = _number(value)
    return f"{round(parsed, 2):g} ms" if parsed is not None else "not captured"


def _build_case_interpretation(
    analytics: dict[str, Any],
    events: list[dict[str, Any]],
    devices: list[dict[str, Any]],
    manifest: dict[str, Any],
) -> dict[str, Any]:
    summary = analytics.get("summary") or {}
    coverage = analytics.get("coverage") or {}
    latency_stats = analytics.get("latency_stats") or {}
    attention = analytics.get("attention_flags") or []
    ordering = analytics.get("ordering_notes") or []
    outgoing_count = int(summary.get("outgoing_send_trace_count") or 0)
    partial_count = int(summary.get("outgoing_partial_trace_count") or 0)
    incoming_count = int(summary.get("observed_incoming_trace_count") or 0)
    message_trace_count = outgoing_count + incoming_count
    manifest_active = str(manifest.get("status") or "").lower() == "active"
    capture_expires_at = _parse_utc(manifest.get("capture_expires_at"))
    is_active = bool(manifest_active and (not capture_expires_at or capture_expires_at > _utc_now()))
    snapshot_status = "preliminary_active_capture" if is_active else "final_capture_expired" if manifest_active else "final_capture_snapshot"
    missing_coverage = [key for key, captured in coverage.items() if not captured]
    captured_coverage = [key for key, captured in coverage.items() if captured]

    if attention:
        classification = "attention_required"
        severity = "attention"
    elif not message_trace_count:
        classification = "insufficient_message_evidence"
        severity = "unknown"
    elif missing_coverage or partial_count:
        classification = "no_failure_observed_partial_evidence"
        severity = "informational"
    else:
        classification = "no_deterministic_failure_observed"
        severity = "informational"

    critical_coverage = sum(bool(coverage.get(key)) for key in ("http_ack", "backend_send", "canonical_observed", "identity_and_reconcile"))
    confidence = "high" if message_trace_count and critical_coverage == 4 and not is_active else "medium" if message_trace_count and critical_coverage >= 2 else "low"
    if attention and confidence == "low":
        confidence = "medium"

    device_labels = sorted({
        " / ".join(str(value or "unknown") for value in (device.get("os"), device.get("browser"), device.get("runtime_kind"), device.get("frontend_version")))
        for device in devices
        if isinstance(device, dict)
    })
    management: list[str] = [
        (
            "This is a preliminary snapshot because capture is still active; findings can change as new events arrive."
            if is_active
            else "This snapshot was analyzed after capture stopped or completed."
        ),
        f"The case contains {message_trace_count} message trace(s) across {len(devices)} captured device session(s)"
        + (f": {', '.join(device_labels[:4])}." if device_labels else "."),
    ]
    if attention:
        management.append(f"Deterministic attention evidence exists: {', '.join(attention)}.")
    elif message_trace_count:
        management.append("No deterministic failure was observed in the captured evidence; this does not prove uncaptured stages were healthy.")
    else:
        management.append("No message trace is available, so user impact and message health cannot be concluded.")

    delivered_avg = (latency_stats.get("canonical_to_delivered_observed_ms") or {}).get("avg_ms")
    read_avg = (latency_stats.get("delivered_to_read_observed_ms") or {}).get("avg_ms")
    if delivered_avg is not None or read_avg is not None:
        management.append(f"Observed timing: canonical to Delivered {_analysis_ms(delivered_avg)}; Delivered to Read {_analysis_ms(read_avg)}.")
    worker_counts = (analytics.get("notification_worker") or {}).get("counts") or {}
    worker_avg = (latency_stats.get("worker_notification_created_to_sent_ms") or {}).get("avg_ms")
    if worker_counts:
        management.append(f"Notification Worker outcomes are {json.dumps(worker_counts, sort_keys=True)} with dedupe-created to sent average {_analysis_ms(worker_avg)}.")
    if missing_coverage:
        management.append(f"Management conclusion is limited by missing evidence: {', '.join(missing_coverage)}.")

    technical: list[str] = [
        f"Direction classification: {int(summary.get('outgoing_complete_trace_count') or 0)} complete outgoing, {partial_count} partial outgoing, and {incoming_count} observed incoming/realtime trace(s).",
        f"Identity/reconcile totals: {(analytics.get('identity_match_totals') or {}).get('matched', 0)} matched, {(analytics.get('identity_match_totals') or {}).get('not_matched', 0)} not matched; {(analytics.get('reconcile_totals') or {}).get('replace', 0)} replace, {(analytics.get('reconcile_totals') or {}).get('insert', 0)} insert.",
    ]
    if partial_count:
        partial_ids = [str(trace.get("trace_id")) for trace in analytics.get("traces") or [] if trace.get("kind") == "outgoing_partial"]
        technical.append(f"Partial outgoing trace(s) were identified from HTTP ACK/optimistic/backend/reconcile send evidence despite missing HTTP START: {', '.join(partial_ids[:5])}.")
    if ordering:
        technical.append(f"Informational parallel-path ordering: {', '.join(ordering)}.")
    if attention:
        technical.append(f"Attention flags requiring inspection: {', '.join(attention)}.")
    if coverage.get("worker_notification"):
        technical.append(f"Worker outcome was correlated by canonical message_id through message_notify_dedupe; retry counter semantics are distinct from total send attempts.")
    collector_stats = _collector_ingest_delay_stats(events)
    if collector_stats.get("count"):
        technical.append(
            "Collector arrival wall-clock estimate: "
            f"min {_analysis_ms(collector_stats.get('min_ms'))}, avg {_analysis_ms(collector_stats.get('avg_ms'))}, max {_analysis_ms(collector_stats.get('max_ms'))}; "
            "this measures batching/clock difference, not product message latency."
        )
    if missing_coverage:
        technical.append(f"Unavailable instrumentation stages: {', '.join(missing_coverage)}.")

    related_files = [
        {"path": "console/admin_backend/admin_api/devlog_routes.py", "component": "Console Backend", "reason": "case analytics, deterministic interpretation and exports"},
        {"path": "frontend_hybrid/src/services/DevLogService.js", "component": "Collabra Frontend", "reason": "activation polling, event queue and batch ingest"},
    ]
    if any(str(event.get("source") or "") == "frontend" or str(event.get("event_code") or "").startswith("DL-FE-") for event in events):
        related_files.append({"path": "frontend_hybrid/src/core/contexts/ChatContextV2.jsx", "component": "Collabra Frontend", "reason": "message send, realtime, reconcile, receipt and visibility events"})
    if coverage.get("backend_send") or "backend_send" in missing_coverage:
        related_files.extend([
            {"path": "backend/advisor/api/api_chat.py", "component": "Collabra Backend", "reason": "DevLog headers and send-request collector boundary"},
            {"path": "backend/advisor/api/chat_logic.py", "component": "Collabra Backend", "reason": "send_message_v5 milestones and backend DevLog events"},
        ])
    if coverage.get("worker_notification"):
        related_files.append({"path": "docs/80-operational-assets/workers/fcm-notify-worker.js", "component": "Cloudflare Worker", "reason": "notification outcome and message_notify_dedupe writer"})

    related_documents = [
        {"path": "docs/10-collabra/1004-0134-01-FA-TECH-Develop_Log_Instrumentation_Protocol.md", "title": "DevLog Instrumentation Protocol"},
        {"path": "docs/10-collabra/1004-0134-01-FA-MGMT-Develop_Log_Executive_Guide.md", "title": "DevLog Executive Guide"},
        {"path": "docs/00-global/0016-0201-01-FA-CTRL-Console_Interaction_Request_Response_Log.md", "title": "Console request 2084"},
        {"path": "docs/10-collabra/1004-0125-01-FA-TECH-Send_Receive_Message_V5.md", "title": "Send/Receive Message V5"},
    ]
    if coverage.get("worker_notification"):
        related_documents.append({"path": "docs/60-database/6006-0001-01-FA-TECH-Database_Schema_Specifications.md", "title": "Database schema and message_notify_dedupe contract"})

    partial_trace = next((trace for trace in analytics.get("traces") or [] if trace.get("kind") == "outgoing_partial"), None)
    if attention:
        next_action = f"Inspect the first flagged trace ({next((trace.get('trace_id') for trace in analytics.get('traces') or [] if trace.get('attention_flags')), 'unknown')}) against the listed source file before changing product behavior."
    elif partial_trace:
        next_action = f"Capture one fresh send on the same device and verify OPTIMISTIC-CREATED, HTTP-START and backend milestones for trace {partial_trace.get('trace_id')}; if they remain absent, inspect the listed frontend send instrumentation."
    elif not message_trace_count:
        next_action = "Send one fresh test message while this DevLog case is active, then refresh the case before drawing a conclusion."
    elif is_active:
        next_action = "Complete the intended reproduction, stop capture, refresh once, and use the final snapshot for the incident conclusion."
    else:
        next_action = "Attach the customer reproduction note or screenshot and compare this final trace with the expected message lifecycle before assigning a code change."

    return {
        "analysis_version": 1,
        "generated_at": _utc_iso(),
        "snapshot_status": snapshot_status,
        "classification": classification,
        "severity": severity,
        "confidence": confidence,
        "confidence_basis": f"{critical_coverage}/4 core stages captured; snapshot={'active' if is_active else 'stopped'}; message_traces={message_trace_count}.",
        "management_summary": management,
        "technical_analysis": technical,
        "captured_evidence": captured_coverage,
        "missing_evidence": missing_coverage,
        "data_quality": {"collector_ingest_delay_ms": collector_stats},
        "related_files": related_files,
        "related_documents": related_documents,
        "next_diagnostic_action": next_action,
        "limitations": [
            "Deterministic interpretation uses captured evidence only and does not infer success or failure for missing stages.",
            "Collector arrival estimates use client/server wall clocks and are not added to product latency.",
            "Selective DevLog cases are incident evidence, not population-level SLA monitoring.",
        ],
    }


def _build_case_analytics(
    events: list[dict[str, Any]],
    devices: list[dict[str, Any]],
    notification_evidence: dict[str, Any] | None = None,
    manifest: dict[str, Any] | None = None,
) -> dict[str, Any]:
    notification_evidence = notification_evidence or {"available": False, "rows": [], "counts": {}, "reason_code": "not_queried"}
    notification_rows = notification_evidence.get("rows") if isinstance(notification_evidence.get("rows"), list) else []
    notification_by_message: dict[str, list[dict[str, Any]]] = {}
    for row in notification_rows:
        if isinstance(row, dict) and row.get("message_id"):
            notification_by_message.setdefault(str(row["message_id"]), []).append(row)
    event_code_counts: dict[str, int] = {}
    source_counts: dict[str, int] = {}
    traces: dict[str, list[dict[str, Any]]] = {}
    for event in events:
        code = str(event.get("event_code") or "unknown")
        source = str(event.get("source") or "unknown")
        trace_id = str(event.get("trace_id") or "untraced")
        event_code_counts[code] = event_code_counts.get(code, 0) + 1
        source_counts[source] = source_counts.get(source, 0) + 1
        traces.setdefault(trace_id, []).append(event)

    trace_analysis: list[dict[str, Any]] = []
    latency_buckets: dict[str, list[float]] = {
        "optimistic_to_http_start_ms": [],
        "http_start_to_ack_ms": [],
        "http_start_to_canonical_ms": [],
        "ack_to_canonical_ms": [],
        "http_start_to_delivered_observed_ms": [],
        "canonical_to_delivered_observed_ms": [],
        "http_start_to_read_observed_ms": [],
        "delivered_to_read_observed_ms": [],
        "backend_rpc_cumulative_ms": [],
        "backend_saved_cumulative_ms": [],
        "backend_post_processing_cumulative_ms": [],
        "backend_persist_after_rpc_ms": [],
        "backend_post_after_saved_ms": [],
        "client_wait_outside_backend_trace_ms": [],
        "worker_notification_created_to_sent_ms": [],
    }
    total_reconcile = {"replace": 0, "insert": 0, "other": 0}
    total_identity = {"matched": 0, "not_matched": 0}

    for trace_id, trace_events in traces.items():
        ordered = sorted(trace_events, key=lambda event: (_number(event.get("client_mono_ms")) or 0, str(event.get("client_wall_at") or "")))
        optimistic = _first_event(ordered, "DL-FE-OPTIMISTIC-CREATED")
        http_start = _first_event(ordered, "DL-FE-HTTP-START")
        http_ack = _first_event(ordered, "DL-FE-HTTP-ACK")
        http_error = _first_event(ordered, "DL-FE-HTTP-ERROR")
        canonical = _first_event(ordered, "DL-FE-CANONICAL-OBSERVED")
        delivered_observed = _first_event(ordered, "DL-FE-STATUS-DELIVERED-OBSERVED")
        read_observed = _first_event(ordered, "DL-FE-STATUS-READ-OBSERVED")
        backend_rpc = _first_event(ordered, "DL-BE-SEND-RPC-COMPLETE")
        backend_saved = _first_event(ordered, "DL-BE-SEND-SAVED")
        backend_post = _first_event(ordered, "DL-BE-SEND-POST-PROCESSING-COMPLETE")
        reconcile_events = [event for event in ordered if event.get("event_code") == "DL-FE-RECONCILE-DECISION"]
        identity_events = [event for event in ordered if event.get("event_code") == "DL-FE-IDENTITY-MATCH-EVALUATED"]
        reconcile_counts = {"replace": 0, "insert": 0, "other": 0}
        for event in reconcile_events:
            details = event.get("details") if isinstance(event.get("details"), dict) else {}
            action = str(details.get("action") or "other")
            bucket = action if action in {"replace", "insert"} else "other"
            reconcile_counts[bucket] += 1
            total_reconcile[bucket] += 1
        identity_counts = {"matched": 0, "not_matched": 0}
        for event in identity_events:
            details = event.get("details") if isinstance(event.get("details"), dict) else {}
            bucket = "matched" if details.get("matched") is True else "not_matched"
            identity_counts[bucket] += 1
            total_identity[bucket] += 1

        latency = {
            "optimistic_to_http_start_ms": _mono_delta(optimistic, http_start),
            "http_start_to_ack_ms": _mono_delta(http_start, http_ack),
            "http_start_to_canonical_ms": _mono_delta(http_start, canonical),
            "ack_to_canonical_ms": _mono_delta(http_ack, canonical),
            "http_start_to_delivered_observed_ms": _mono_delta(http_start, delivered_observed),
            "canonical_to_delivered_observed_ms": _mono_delta(canonical, delivered_observed),
            "http_start_to_read_observed_ms": _mono_delta(http_start, read_observed),
            "delivered_to_read_observed_ms": _mono_delta(delivered_observed, read_observed),
            "backend_rpc_cumulative_ms": _number((backend_rpc or {}).get("duration_ms")),
            "backend_saved_cumulative_ms": _number((backend_saved or {}).get("duration_ms")),
            "backend_post_processing_cumulative_ms": _number((backend_post or {}).get("duration_ms")),
        }
        rpc_value = latency["backend_rpc_cumulative_ms"]
        saved_value = latency["backend_saved_cumulative_ms"]
        post_value = latency["backend_post_processing_cumulative_ms"]
        http_value = latency["http_start_to_ack_ms"]
        latency["backend_persist_after_rpc_ms"] = _rounded(saved_value - rpc_value) if saved_value is not None and rpc_value is not None else None
        latency["backend_post_after_saved_ms"] = _rounded(post_value - saved_value) if post_value is not None and saved_value is not None else None
        latency["client_wait_outside_backend_trace_ms"] = _rounded(http_value - post_value) if http_value is not None and post_value is not None else None
        for key, value in latency.items():
            if value is not None and key in latency_buckets:
                latency_buckets[key].append(float(value))

        outgoing_marker = bool(optimistic or http_start or http_ack or http_error or backend_rpc or backend_saved or backend_post)
        if not outgoing_marker:
            outgoing_marker = any(
                "http_ack" in str(event.get("reason_code") or "").lower()
                or "http_ack" in str((event.get("details") if isinstance(event.get("details"), dict) else {}).get("source") or "").lower()
                for event in reconcile_events
            )
        flags = []
        ordering_notes = []
        evidence_gaps = []
        if http_start and not http_ack:
            flags.append("missing_http_ack")
        if http_error:
            flags.append("http_error")
        if http_start and not canonical:
            flags.append("missing_canonical_observation")
        if latency["ack_to_canonical_ms"] is not None and latency["ack_to_canonical_ms"] < 0:
            ordering_notes.append(f"canonical_arrived_before_http_ack:{abs(latency['ack_to_canonical_ms']):g}ms")
        if outgoing_marker and reconcile_counts["insert"]:
            flags.append("outgoing_reconcile_insert")
        if outgoing_marker and identity_counts["not_matched"]:
            flags.append("outgoing_identity_no_match")
        if outgoing_marker and read_observed and not delivered_observed:
            flags.append("read_observed_without_delivered_event")
        if outgoing_marker and not http_start:
            evidence_gaps.append("missing_http_start")
        if outgoing_marker and not optimistic:
            evidence_gaps.append("missing_optimistic_created")
        if outgoing_marker and not any((backend_rpc, backend_saved, backend_post)):
            evidence_gaps.append("missing_backend_send_milestones")

        first_identity = next((event for event in ordered if event.get("client_message_id")), None)
        first_message = next((event for event in (canonical, http_ack) if event and event.get("message_id")), None)
        if not first_message:
            first_message = next((event for event in ordered if event.get("message_id")), None)
        trace_kind = "outgoing_send" if http_start else "outgoing_partial" if outgoing_marker else "observed_incoming_or_realtime" if canonical else "auxiliary"
        message_id = (first_message or {}).get("message_id")
        matched_notification_rows = notification_by_message.get(str(message_id), []) if message_id else []
        if any(row.get("notify_state") == "failed" for row in matched_notification_rows):
            flags.append("worker_notification_failed")
        if any(row.get("notify_state") == "pending" for row in matched_notification_rows):
            flags.append("worker_notification_pending")
        for row in matched_notification_rows:
            value = _number(row.get("created_to_sent_ms"))
            if value is not None:
                latency_buckets["worker_notification_created_to_sent_ms"].append(value)
        trace_analysis.append({
            "trace_id": trace_id,
            "kind": trace_kind,
            "client_message_id": (first_identity or {}).get("client_message_id"),
            "message_id": message_id,
            "conversation_id": next((event.get("conversation_id") for event in ordered if event.get("conversation_id")), None),
            "device_session_ref": str(((ordered[0].get("device") or {}) if ordered else {}).get("device_session_ref") or "unknown"),
            "event_count": len(ordered),
            "event_sequence": [str(event.get("event_code") or "unknown") for event in ordered],
            "canonical_observation_count": sum(1 for event in ordered if event.get("event_code") == "DL-FE-CANONICAL-OBSERVED"),
            "delivered_observation_count": sum(1 for event in ordered if event.get("event_code") == "DL-FE-STATUS-DELIVERED-OBSERVED"),
            "read_observation_count": sum(1 for event in ordered if event.get("event_code") == "DL-FE-STATUS-READ-OBSERVED"),
            "reconcile": reconcile_counts,
            "identity_match": identity_counts,
            "latency": {key: _rounded(value) for key, value in latency.items()},
            "attention_flags": flags,
            "ordering_notes": ordering_notes,
            "evidence_gaps": evidence_gaps,
            "notification_worker": {
                "outcome_count": len(matched_notification_rows),
                "states": dict(sorted({
                    state: sum(1 for row in matched_notification_rows if str(row.get("notify_state") or "unknown") == state)
                    for state in {str(row.get("notify_state") or "unknown") for row in matched_notification_rows}
                }.items())),
                "rows": matched_notification_rows,
            },
        })

    trace_analysis.sort(key=lambda item: (item["kind"] not in {"outgoing_send", "outgoing_partial"}, item["trace_id"]))
    codes = set(event_code_counts)
    coverage = {
        "optimistic_created": "DL-FE-OPTIMISTIC-CREATED" in codes,
        "http_start": "DL-FE-HTTP-START" in codes,
        "http_ack": "DL-FE-HTTP-ACK" in codes,
        "backend_send": any(code.startswith("DL-BE-SEND-") for code in codes),
        "canonical_observed": "DL-FE-CANONICAL-OBSERVED" in codes,
        "identity_and_reconcile": "DL-FE-IDENTITY-MATCH-EVALUATED" in codes and "DL-FE-RECONCILE-DECISION" in codes,
        "delivered_status": any("DELIVER" in code for code in codes),
        "read_status": any("READ" in code for code in codes),
        "visibility_lifecycle": any("VISIBLE" in code or "VISIBILITY" in code for code in codes),
        "worker_notification": bool(notification_rows) or any(code.startswith("DL-WK-") or "NOTIFY" in code for code in codes),
    }
    outgoing_complete = [item for item in trace_analysis if item["kind"] == "outgoing_send"]
    outgoing_partial = [item for item in trace_analysis if item["kind"] == "outgoing_partial"]
    outgoing = [*outgoing_complete, *outgoing_partial]
    incoming = [item for item in trace_analysis if item["kind"] == "observed_incoming_or_realtime"]
    auxiliary = [item for item in trace_analysis if item["kind"] == "auxiliary"]
    attention = sorted({flag for item in trace_analysis for flag in item["attention_flags"]})
    ordering_notes = sorted({note for item in trace_analysis for note in item["ordering_notes"]})
    analytics = {
        "schema_version": 2,
        "computed_at": _utc_iso(),
        "summary": {
            "event_count": len(events),
            "trace_count": len(trace_analysis),
            "device_count": len(devices),
            "outgoing_send_trace_count": len(outgoing),
            "outgoing_complete_trace_count": len(outgoing_complete),
            "outgoing_partial_trace_count": len(outgoing_partial),
            "observed_incoming_trace_count": len(incoming),
            "auxiliary_trace_count": len(auxiliary),
            "attention_flag_count": sum(len(item["attention_flags"]) for item in trace_analysis),
            "ordering_note_count": sum(len(item["ordering_notes"]) for item in trace_analysis),
            "worker_notification_outcome_count": len(notification_rows),
        },
        "latency_stats": {key: _latency_stats(values) for key, values in latency_buckets.items()},
        "coverage": coverage,
        "reconcile_totals": total_reconcile,
        "identity_match_totals": total_identity,
        "event_code_counts": dict(sorted(event_code_counts.items())),
        "source_counts": dict(sorted(source_counts.items())),
        "attention_flags": attention,
        "ordering_notes": ordering_notes,
        "notification_worker": {
            "evidence_available": bool(notification_evidence.get("available")),
            "source": notification_evidence.get("source"),
            "query_latency_ms": notification_evidence.get("query_latency_ms"),
            "reason_code": notification_evidence.get("reason_code"),
            "counts": notification_evidence.get("counts") or {},
        },
        "traces": trace_analysis,
    }
    analytics["interpretation"] = _build_case_interpretation(analytics, events, devices, manifest or {})
    return analytics


def _case_response(manifest: dict[str, Any], *, include_events: bool = False) -> dict[str, Any]:
    events: list[dict[str, Any]] = []
    devices: list[dict[str, Any]] = []
    if include_events:
        events, devices = _load_case_events(str(manifest.get("case_id") or ""))
    notification_evidence = _load_notification_evidence(events) if include_events else {"available": False, "rows": [], "counts": {}, "reason_code": "events_not_loaded"}
    return {
        "manifest": manifest,
        "countdown": _countdown_state(manifest),
        "events": events,
        "devices": devices,
        "artifacts": _list_artifacts(str(manifest.get("case_id") or "")),
        "event_count": len(events),
        "notification_evidence": notification_evidence,
        "analytics": _build_case_analytics(events, devices, notification_evidence, manifest),
        "storage_path": f"gs://{BUCKET_NAME}/{_case_prefix(str(manifest.get('case_id') or ''))}/",
    }


@devlog_bp.get("/api/console/devlog/cases")
@require_capability("console.view_user_devlog")
def list_devlog_cases():
    cleaned = _cleanup_expired_cases()
    user_id = str(request.args.get("user_id") or "").strip() or None
    return jsonify({
        "status": "ok",
        "bucket": BUCKET_NAME,
        "root": DEBUG_CASES_ROOT,
        "cleaned_expired_cases": cleaned,
        "cases": _case_summaries(user_id),
    })


@devlog_bp.post("/api/console/devlog/cases")
@require_capability("console.manage_user_devlog")
def create_devlog_case():
    actor = resolve_actor(request)
    payload = request.get_json(silent=True) or {}
    user_id = str(payload.get("user_id") or "").strip()
    if not _USER_ID_RE.fullmatch(user_id):
        return jsonify({"status": "error", "message": "A UUID user_id is required."}), 400

    existing_pointer = _read_json(_active_pointer_path(user_id))
    if existing_pointer:
        existing_manifest = _read_manifest(str(existing_pointer.get("case_id") or ""))
        if existing_manifest and existing_manifest.get("status") == "active" and not _countdown_state(existing_manifest)["capture_remaining_seconds"] == 0:
            return jsonify({"status": "conflict", "message": "This user already has an active DevLog case.", "case": existing_manifest}), 409

    now = _utc_now()
    capture_minutes = _bounded_int(payload.get("capture_minutes"), DEFAULT_CAPTURE_MINUTES, 5, MAX_CAPTURE_MINUTES)
    retention_days = _bounded_int(payload.get("retention_days"), DEFAULT_RETENTION_DAYS, 1, MAX_RETENTION_DAYS)
    case_id = f"dl-{now.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:10]}"
    manifest = {
        "schema_version": 1,
        "case_id": case_id,
        "user_id": user_id,
        "user_label": str(payload.get("user_label") or user_id)[:240],
        "title": str(payload.get("title") or "User DevLog investigation")[:240],
        "status": "active",
        "capture_groups": payload.get("capture_groups") if isinstance(payload.get("capture_groups"), list) else ["message_lifecycle"],
        "capture_started_at": _utc_iso(now),
        "capture_expires_at": _utc_iso(now + dt.timedelta(minutes=capture_minutes)),
        "capture_minutes": capture_minutes,
        "retention_days": retention_days,
        "retention_started_at": None,
        "first_download_at": None,
        "expires_at": None,
        "created_at": _utc_iso(now),
        "created_by": actor.email or actor.user_id,
        "updated_at": _utc_iso(now),
        "notes": [],
    }
    _write_manifest(manifest)
    _write_json(_active_pointer_path(user_id), {
        "case_id": case_id,
        "user_id": user_id,
        "capture_expires_at": manifest["capture_expires_at"],
        "updated_at": manifest["updated_at"],
    })
    return jsonify({"status": "ok", "case": _case_response(manifest)})


@devlog_bp.get("/api/console/devlog/cases/<case_id>")
@require_capability("console.view_user_devlog")
def get_devlog_case(case_id: str):
    manifest = _read_manifest(case_id)
    if not manifest:
        return jsonify({"status": "not_found", "message": "DevLog case not found."}), 404
    if _countdown_state(manifest)["expired"]:
        _delete_case(case_id, str(manifest.get("user_id") or "") or None)
        return jsonify({"status": "expired", "message": "DevLog retention elapsed and the case was deleted."}), 410
    return jsonify({"status": "ok", "case": _case_response(manifest, include_events=True)})


@devlog_bp.post("/api/console/devlog/cases/<case_id>/stop")
@require_capability("console.manage_user_devlog")
def stop_devlog_case(case_id: str):
    actor = resolve_actor(request)
    manifest = _read_manifest(case_id)
    if not manifest:
        return jsonify({"status": "not_found"}), 404
    manifest["status"] = "stopped"
    manifest["stopped_at"] = _utc_iso()
    manifest["stopped_by"] = actor.email or actor.user_id
    _write_manifest(manifest)
    pointer_blob = _storage().bucket(BUCKET_NAME).blob(_active_pointer_path(str(manifest.get("user_id") or "")))
    pointer = _read_json(pointer_blob.name)
    if pointer and pointer.get("case_id") == case_id and pointer_blob.exists():
        pointer_blob.delete()
    return jsonify({"status": "ok", "case": _case_response(manifest, include_events=True)})


def _start_retention(manifest: dict[str, Any], actor_value: str, source: str) -> None:
    if manifest.get("retention_started_at"):
        return
    now = _utc_now()
    retention_days = _bounded_int(manifest.get("retention_days"), DEFAULT_RETENTION_DAYS, 1, MAX_RETENTION_DAYS)
    manifest["retention_started_at"] = _utc_iso(now)
    manifest["first_download_at"] = manifest.get("first_download_at") or (_utc_iso(now) if source == "download" else None)
    manifest["expires_at"] = _utc_iso(now + dt.timedelta(days=retention_days))
    manifest["retention_started_by"] = actor_value
    manifest["retention_start_source"] = source
    _write_manifest(manifest)


@devlog_bp.post("/api/console/devlog/cases/<case_id>/download-confirmed")
@require_capability("console.manage_user_devlog")
def confirm_devlog_download(case_id: str):
    actor = resolve_actor(request)
    manifest = _read_manifest(case_id)
    if not manifest:
        return jsonify({"status": "not_found"}), 404
    _start_retention(manifest, actor.email or actor.user_id, "download")
    return jsonify({"status": "ok", "case": _case_response(manifest)})


@devlog_bp.post("/api/console/devlog/cases/<case_id>/start-retention")
@require_capability("console.manage_user_devlog")
def start_devlog_retention(case_id: str):
    actor = resolve_actor(request)
    manifest = _read_manifest(case_id)
    if not manifest:
        return jsonify({"status": "not_found"}), 404
    _start_retention(manifest, actor.email or actor.user_id, "manual")
    return jsonify({"status": "ok", "case": _case_response(manifest)})


@devlog_bp.post("/api/console/devlog/cases/<case_id>/notes")
@require_capability("console.manage_user_devlog")
def add_devlog_note(case_id: str):
    actor = resolve_actor(request)
    payload = request.get_json(silent=True) or {}
    text = str(payload.get("text") or "").strip()
    if not text:
        return jsonify({"status": "error", "message": "Note text is required."}), 400
    manifest = _read_manifest(case_id)
    if not manifest:
        return jsonify({"status": "not_found"}), 404
    notes = manifest.get("notes") if isinstance(manifest.get("notes"), list) else []
    notes.append({
        "note_id": uuid.uuid4().hex,
        "text": text[:4_000],
        "created_at": _utc_iso(),
        "created_by": actor.email or actor.user_id,
    })
    manifest["notes"] = notes[-200:]
    _write_manifest(manifest)
    return jsonify({"status": "ok", "case": _case_response(manifest, include_events=True)})


@devlog_bp.post("/api/console/devlog/cases/<case_id>/artifacts")
@require_capability("console.manage_user_devlog")
def upload_devlog_artifact(case_id: str):
    manifest = _read_manifest(case_id)
    if not manifest:
        return jsonify({"status": "not_found"}), 404
    uploaded = request.files.get("file")
    if not uploaded or not uploaded.filename:
        return jsonify({"status": "error", "message": "Artifact file is required."}), 400
    safe_name = secure_filename(uploaded.filename)
    extension = safe_name.rsplit(".", 1)[-1].lower() if "." in safe_name else ""
    if extension not in ALLOWED_ARTIFACT_EXTENSIONS:
        return jsonify({"status": "error", "message": "Artifact type is not allowed."}), 400
    content = uploaded.read(MAX_ARTIFACT_BYTES + 1)
    if len(content) > MAX_ARTIFACT_BYTES:
        return jsonify({"status": "error", "message": "Artifact is too large."}), 413
    object_name = f"{_case_prefix(case_id)}/artifacts/{uuid.uuid4().hex[:10]}-{safe_name}"
    _storage().bucket(BUCKET_NAME).blob(object_name).upload_from_string(
        content,
        content_type=uploaded.mimetype or "application/octet-stream",
    )
    return jsonify({"status": "ok", "path": object_name, "case": _case_response(manifest, include_events=True)})


def _flatten_event(event: dict[str, Any]) -> dict[str, Any]:
    device = event.get("device") if isinstance(event.get("device"), dict) else {}
    return {
        "row_type": "event",
        "server_received_at": event.get("server_received_at"),
        "client_wall_at": event.get("client_wall_at"),
        "event_code": event.get("event_code"),
        "trace_id": event.get("trace_id"),
        "client_message_id": event.get("client_message_id"),
        "message_id": event.get("message_id"),
        "conversation_id": event.get("conversation_id"),
        "source": event.get("source"),
        "status": event.get("status"),
        "reason_code": event.get("reason_code"),
        "duration_ms": event.get("duration_ms"),
        "device_session_ref": device.get("device_session_ref"),
        "device_key": device.get("device_key"),
        "os": device.get("os"),
        "browser": device.get("browser"),
        "runtime_kind": device.get("runtime_kind"),
        "details": json.dumps(event.get("details") or {}, ensure_ascii=False, sort_keys=True),
    }


def _analytics_csv_rows(analytics: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for metric, value in (analytics.get("summary") or {}).items():
        rows.append({"row_type": "summary", "metric": metric, "value": value})
    for metric, stats in (analytics.get("latency_stats") or {}).items():
        rows.append({"row_type": "latency_summary", "metric": metric, **(stats or {})})
    for metric, value in (analytics.get("coverage") or {}).items():
        rows.append({"row_type": "coverage", "metric": metric, "value": value})
    interpretation = analytics.get("interpretation") if isinstance(analytics.get("interpretation"), dict) else {}
    for metric in ("analysis_version", "snapshot_status", "classification", "severity", "confidence", "confidence_basis", "next_diagnostic_action"):
        rows.append({"row_type": "case_analysis", "analysis_section": "metadata", "metric": metric, "value": interpretation.get(metric)})
    for section_key in ("management_summary", "technical_analysis", "captured_evidence", "missing_evidence", "limitations"):
        for index, value in enumerate(interpretation.get(section_key) or [], start=1):
            rows.append({"row_type": "case_analysis", "analysis_section": section_key, "metric": index, "value": value})
    for reference_kind in ("related_files", "related_documents"):
        for reference in interpretation.get(reference_kind) or []:
            rows.append({
                "row_type": "case_analysis_reference",
                "analysis_section": reference_kind,
                "reference_path": reference.get("path"),
                "reference_title": reference.get("title") or reference.get("component"),
                "value": reference.get("reason"),
            })
    for trace in analytics.get("traces") or []:
        latency = trace.get("latency") if isinstance(trace.get("latency"), dict) else {}
        reconcile = trace.get("reconcile") if isinstance(trace.get("reconcile"), dict) else {}
        identity = trace.get("identity_match") if isinstance(trace.get("identity_match"), dict) else {}
        notification = trace.get("notification_worker") if isinstance(trace.get("notification_worker"), dict) else {}
        rows.append({
            "row_type": "trace_analysis",
            "trace_id": trace.get("trace_id"),
            "trace_kind": trace.get("kind"),
            "client_message_id": trace.get("client_message_id"),
            "message_id": trace.get("message_id"),
            "conversation_id": trace.get("conversation_id"),
            "event_count": trace.get("event_count"),
            "canonical_observation_count": trace.get("canonical_observation_count"),
            "optimistic_to_http_start_ms": latency.get("optimistic_to_http_start_ms"),
            "http_start_to_ack_ms": latency.get("http_start_to_ack_ms"),
            "http_start_to_canonical_ms": latency.get("http_start_to_canonical_ms"),
            "ack_to_canonical_ms": latency.get("ack_to_canonical_ms"),
            "http_start_to_delivered_observed_ms": latency.get("http_start_to_delivered_observed_ms"),
            "canonical_to_delivered_observed_ms": latency.get("canonical_to_delivered_observed_ms"),
            "http_start_to_read_observed_ms": latency.get("http_start_to_read_observed_ms"),
            "delivered_to_read_observed_ms": latency.get("delivered_to_read_observed_ms"),
            "backend_rpc_cumulative_ms": latency.get("backend_rpc_cumulative_ms"),
            "backend_saved_cumulative_ms": latency.get("backend_saved_cumulative_ms"),
            "backend_post_processing_cumulative_ms": latency.get("backend_post_processing_cumulative_ms"),
            "backend_persist_after_rpc_ms": latency.get("backend_persist_after_rpc_ms"),
            "backend_post_after_saved_ms": latency.get("backend_post_after_saved_ms"),
            "client_wait_outside_backend_trace_ms": latency.get("client_wait_outside_backend_trace_ms"),
            "reconcile_replace": reconcile.get("replace"),
            "reconcile_insert": reconcile.get("insert"),
            "identity_matched": identity.get("matched"),
            "identity_not_matched": identity.get("not_matched"),
            "attention_flags": "|".join(trace.get("attention_flags") or []),
            "ordering_notes": "|".join(trace.get("ordering_notes") or []),
            "evidence_gaps": "|".join(trace.get("evidence_gaps") or []),
            "event_sequence": " > ".join(trace.get("event_sequence") or []),
            "worker_notification_outcome_count": notification.get("outcome_count"),
            "worker_notification_states": json.dumps(notification.get("states") or {}, sort_keys=True),
        })
        for evidence in notification.get("rows") or []:
            rows.append({
                "row_type": "worker_notification_evidence",
                "trace_id": trace.get("trace_id"),
                "message_id": evidence.get("message_id"),
                "recipient_user_id": evidence.get("recipient_user_id"),
                "route_selected": evidence.get("route_selected"),
                "notify_state": evidence.get("notify_state"),
                "created_at": evidence.get("created_at"),
                "sent_at": evidence.get("sent_at"),
                "last_attempt_at": evidence.get("last_attempt_at"),
                "attempts": evidence.get("attempts"),
                "worker_notification_created_to_sent_ms": evidence.get("created_to_sent_ms"),
                "last_error_code": evidence.get("last_error_code"),
            })
    return rows


def _html(value: Any) -> str:
    return html_lib.escape(str(value if value is not None and value != "" else "—"), quote=True)


def _ms(value: Any) -> str:
    parsed = _number(value)
    return f"{round(parsed, 2):g} ms" if parsed is not None else "not captured"


def _mermaid_node_label(title: str, value: Any = None, subtitle: str | None = None) -> str:
    parts = [title]
    if value is not None:
        parts.append(_ms(value))
    if subtitle:
        parts.append(subtitle)
    return "<br/>".join(part.replace('"', "'") for part in parts)


def _largest_measured_segment(trace: dict[str, Any]) -> tuple[str, float] | None:
    latency = trace.get("latency") if isinstance(trace.get("latency"), dict) else {}
    candidates = {
        "Backend entry → RPC": latency.get("backend_rpc_cumulative_ms"),
        "RPC → Saved": latency.get("backend_persist_after_rpc_ms"),
        "Saved → Post": latency.get("backend_post_after_saved_ms"),
        "HTTP wait outside backend trace": latency.get("client_wait_outside_backend_trace_ms"),
        "ACK → Canonical": latency.get("ack_to_canonical_ms"),
        "Canonical → Delivered": latency.get("canonical_to_delivered_observed_ms"),
        "Delivered → Read": latency.get("delivered_to_read_observed_ms"),
    }
    measured = [(label, value) for label, raw in candidates.items() if (value := _number(raw)) is not None and value >= 0]
    return max(measured, key=lambda item: item[1]) if measured else None


def _outgoing_mermaid(trace: dict[str, Any], graph_index: int) -> str:
    prefix = f"g{graph_index}_"
    latency = trace.get("latency") if isinstance(trace.get("latency"), dict) else {}
    reconcile = trace.get("reconcile") if isinstance(trace.get("reconcile"), dict) else {}
    flags = trace.get("attention_flags") or []
    ordering_notes = trace.get("ordering_notes") or []
    notification = trace.get("notification_worker") if isinstance(trace.get("notification_worker"), dict) else {}
    notification_rows = notification.get("rows") if isinstance(notification.get("rows"), list) else []
    largest = _largest_measured_segment(trace)
    values = {
        "rpc": latency.get("backend_rpc_cumulative_ms"),
        "saved": latency.get("backend_saved_cumulative_ms"),
        "post": latency.get("backend_post_processing_cumulative_ms"),
        "ack": latency.get("http_start_to_ack_ms"),
        "canonical": latency.get("http_start_to_canonical_ms"),
        "delivered": latency.get("http_start_to_delivered_observed_ms"),
        "read": latency.get("http_start_to_read_observed_ms"),
    }
    lines = [
        "flowchart LR",
        f"subgraph {prefix}client[\"Client / Device\"]",
        f"{prefix}opt[\"{_mermaid_node_label('Optimistic bubble', 0, 'message created locally')}\"]",
        f"{prefix}http[\"{_mermaid_node_label('HTTP start')}\"]",
        "end",
        f"subgraph {prefix}backend[\"Backend / Database\"]",
        f"{prefix}rpc[\"{_mermaid_node_label('RPC complete', values['rpc'], 'cumulative backend')}\"]",
        f"{prefix}saved[\"{_mermaid_node_label('Message saved', values['saved'], 'cumulative backend')}\"]",
        f"{prefix}post[\"{_mermaid_node_label('Post processing', values['post'], 'cumulative backend')}\"]",
        "end",
        f"subgraph {prefix}return[\"Network / Realtime / Receipt\"]",
        f"{prefix}ack[\"{_mermaid_node_label('HTTP ACK', values['ack'], 'from HTTP start')}\"]",
        f"{prefix}canonical[\"{_mermaid_node_label('Canonical observed', values['canonical'], 'from HTTP start')}\"]",
        f"{prefix}reconcile[\"Reconcile<br/>{reconcile.get('replace', 0)} replace / {reconcile.get('insert', 0)} insert\"]",
        f"{prefix}delivered[\"{_mermaid_node_label('Delivered observed', values['delivered'], 'from HTTP start')}\"]",
        f"{prefix}read[\"{_mermaid_node_label('Read observed', values['read'], 'from HTTP start')}\"]",
        "end",
        f"{prefix}opt -->|\"{_ms(latency.get('optimistic_to_http_start_ms'))}\"| {prefix}http",
        f"{prefix}http -->|\"backend cumulative {_ms(values['rpc'])}\"| {prefix}rpc",
        f"{prefix}rpc -->|\"{_ms(latency.get('backend_persist_after_rpc_ms'))}\"| {prefix}saved",
        f"{prefix}saved -->|\"{_ms(latency.get('backend_post_after_saved_ms'))}\"| {prefix}post",
        f"{prefix}post -->|\"outside backend trace {_ms(latency.get('client_wait_outside_backend_trace_ms'))}\"| {prefix}ack",
        f"{prefix}ack -->|\"{_ms(latency.get('ack_to_canonical_ms'))}\"| {prefix}canonical",
        f"{prefix}canonical --> {prefix}reconcile",
        f"{prefix}reconcile -->|\"{_ms(latency.get('canonical_to_delivered_observed_ms'))}\"| {prefix}delivered",
        f"{prefix}delivered -->|\"{_ms(latency.get('delivered_to_read_observed_ms'))}\"| {prefix}read",
    ]
    if notification_rows:
        states = notification.get("states") or {}
        worker_latency = max((_number(row.get("created_to_sent_ms")) or 0 for row in notification_rows), default=0)
        worker_state = ", ".join(f"{key}:{value}" for key, value in states.items()) or "outcome captured"
        attempts = sum(int(_number(row.get("attempts")) or 0) for row in notification_rows)
        lines.extend([
            f"{prefix}worker[\"{_mermaid_node_label('Notification Worker', worker_latency, f'{worker_state}; retry count:{attempts}')}\"]",
            f"{prefix}saved -.->|\"DB webhook / dedupe outcome\"| {prefix}worker",
            f"class {prefix}worker {'attention' if any(row.get('notify_state') == 'failed' for row in notification_rows) else 'captured'}",
        ])
    if largest:
        lines.extend([
            f"{prefix}largest[\"Largest measured segment<br/>{largest[0]}<br/>{_ms(largest[1])}<br/>candidate only; not root-cause proof\"]",
            f"{prefix}post -.-> {prefix}largest",
            f"class {prefix}largest bottleneck",
        ])
    if flags:
        safe_flags = ", ".join(str(flag).replace('"', "'") for flag in flags)
        lines.extend([
            f"{prefix}flags[\"Attention flags<br/>{safe_flags}\"]",
            f"{prefix}canonical -.-> {prefix}flags",
            f"class {prefix}flags attention",
        ])
    if ordering_notes:
        safe_notes = ", ".join(str(note).replace('"', "'") for note in ordering_notes)
        lines.extend([
            f"{prefix}ordering[\"Ordering note<br/>{safe_notes}\"]",
            f"{prefix}ack -.-> {prefix}ordering",
            f"class {prefix}ordering info",
        ])
    captured_nodes = [name for name, value in values.items() if value is not None]
    missing_nodes = [name for name, value in values.items() if value is None]
    if captured_nodes:
        lines.append(f"class {','.join(prefix + name for name in captured_nodes)} captured")
    if missing_nodes:
        lines.append(f"class {','.join(prefix + name for name in missing_nodes)} missing")
    lines.extend([
        f"class {prefix}opt,{prefix}http,{prefix}reconcile captured",
        "classDef captured fill:#dcfce7,stroke:#16803a,color:#102a19,stroke-width:2px",
        "classDef missing fill:#f3f4f6,stroke:#94a3b8,color:#475569,stroke-dasharray:5 5",
        "classDef bottleneck fill:#fef3c7,stroke:#d97706,color:#78350f,stroke-width:2px",
        "classDef attention fill:#fee2e2,stroke:#dc2626,color:#7f1d1d,stroke-width:2px",
        "classDef info fill:#dbeafe,stroke:#2563eb,color:#1e3a8a,stroke-width:2px",
    ])
    return "\n".join(lines)


def _incoming_mermaid(trace: dict[str, Any], trace_events: list[dict[str, Any]], graph_index: int) -> str:
    prefix = f"g{graph_index}_"
    ordered = sorted(trace_events, key=lambda event: (_number(event.get("client_mono_ms")) or 0, str(event.get("client_wall_at") or "")))[:40]
    lines = ["flowchart LR"]
    previous_id = None
    previous_event = None
    error_nodes = []
    for event_index, event in enumerate(ordered):
        node_id = f"{prefix}e{event_index}"
        code = str(event.get("event_code") or "unknown").replace("DL-FE-", "").replace("DL-BE-", "")
        status = str(event.get("status") or "")
        label = _mermaid_node_label(code, event.get("duration_ms"), status or None)
        lines.append(f"{node_id}[\"{label}\"]")
        if previous_id:
            delta = _mono_delta(previous_event, event)
            lines.append(f"{previous_id} -->|\"{_ms(delta)}\"| {node_id}")
        previous_id = node_id
        previous_event = event
        if "ERROR" in code or status.lower() in {"error", "failed"}:
            error_nodes.append(node_id)
    if len(trace_events) > len(ordered) and previous_id:
        more_id = f"{prefix}more"
        lines.extend([f"{more_id}[\"{len(trace_events) - len(ordered)} more events in timeline table\"]", f"{previous_id} --> {more_id}"])
        previous_id = more_id
    notification = trace.get("notification_worker") if isinstance(trace.get("notification_worker"), dict) else {}
    notification_rows = notification.get("rows") if isinstance(notification.get("rows"), list) else []
    if notification_rows:
        worker_id = f"{prefix}worker"
        states = notification.get("states") or {}
        worker_latency = max((_number(row.get("created_to_sent_ms")) or 0 for row in notification_rows), default=0)
        worker_state = ", ".join(f"{key}:{value}" for key, value in states.items()) or "outcome captured"
        lines.append(f"{worker_id}[\"{_mermaid_node_label('Notification Worker', worker_latency, worker_state)}\"]")
        if previous_id:
            lines.append(f"{previous_id} -.->|\"correlated by message id\"| {worker_id}")
        lines.append(f"class {worker_id} {'attention' if any(row.get('notify_state') == 'failed' for row in notification_rows) else 'captured'}")
    if error_nodes:
        lines.append(f"class {','.join(error_nodes)} attention")
    lines.extend([
        "classDef captured fill:#dcfce7,stroke:#16803a,color:#102a19,stroke-width:2px",
        "classDef attention fill:#fee2e2,stroke:#dc2626,color:#7f1d1d,stroke-width:2px",
    ])
    return "\n".join(lines)


def _trace_timeline_html(trace_events: list[dict[str, Any]]) -> str:
    ordered = sorted(trace_events, key=lambda event: (_number(event.get("client_mono_ms")) or 0, str(event.get("client_wall_at") or "")))
    rows = []
    previous = None
    for event in ordered:
        rows.append(
            "<tr>"
            f"<td>{_html(event.get('client_wall_at') or event.get('server_received_at'))}</td>"
            f"<td>{_html(event.get('event_code'))}</td>"
            f"<td>{_html(_ms(_mono_delta(previous, event)) if previous else 'start')}</td>"
            f"<td>{_html(event.get('duration_ms'))}</td>"
            f"<td>{_html(event.get('status'))}</td>"
            f"<td>{_html(event.get('reason_code'))}</td>"
            f"<td><code>{_html(json.dumps(event.get('details') or {}, ensure_ascii=False, sort_keys=True))}</code></td>"
            "</tr>"
        )
        previous = event
    return "".join(rows) or '<tr><td colspan="7">No events captured.</td></tr>'


def _build_html_export(snapshot: dict[str, Any]) -> str:
    manifest = snapshot["manifest"]
    analytics = snapshot["analytics"]
    events = snapshot["events"]
    events_by_trace: dict[str, list[dict[str, Any]]] = {}
    for event in events:
        events_by_trace.setdefault(str(event.get("trace_id") or "untraced"), []).append(event)
    outgoing = [trace for trace in analytics.get("traces") or [] if trace.get("kind") in {"outgoing_send", "outgoing_partial"}]
    incoming = [trace for trace in analytics.get("traces") or [] if trace.get("kind") == "observed_incoming_or_realtime"]
    interpretation = analytics.get("interpretation") if isinstance(analytics.get("interpretation"), dict) else {}
    graph_index = 0

    def trace_cards(traces: list[dict[str, Any]], direction: str) -> str:
        nonlocal graph_index
        cards = []
        for trace in traces:
            graph_index += 1
            trace_id = str(trace.get("trace_id") or "untraced")
            trace_events = events_by_trace.get(trace_id, [])
            graph = _outgoing_mermaid(trace, graph_index) if trace.get("kind") == "outgoing_send" else _incoming_mermaid(trace, trace_events, graph_index)
            flags = ", ".join(trace.get("attention_flags") or []) or "No deterministic error flag captured"
            ordering = ", ".join(trace.get("ordering_notes") or []) or "No special ordering note"
            notification = trace.get("notification_worker") if isinstance(trace.get("notification_worker"), dict) else {}
            notification_summary = ", ".join(f"{key}={value}" for key, value in (notification.get("states") or {}).items()) or "No matching Worker outcome"
            cards.append(f"""
<article class="message-card {direction}">
  <header><div><span class="direction">{_html('OUTGOING PARTIAL' if trace.get('kind') == 'outgoing_partial' else direction.upper())}</span><h3>{_html(trace.get('message_id') or trace.get('client_message_id') or trace_id)}</h3></div><span>{_html(trace.get('device_session_ref'))}</span></header>
  <div class="ids"><b>Trace:</b> <code>{_html(trace_id)}</code> · <b>Conversation:</b> <code>{_html(trace.get('conversation_id'))}</code> · <b>Events:</b> {_html(trace.get('event_count'))}</div>
  <div class="mermaid-wrap"><pre class="mermaid">{_html(graph)}</pre></div>
  <p class="flags"><b>Error/attention evidence:</b> {_html(flags)}</p>
  <p class="ordering"><b>Ordering notes:</b> {_html(ordering)}</p>
  <p class="worker"><b>Worker notification evidence:</b> {_html(notification_summary)} · source=<code>message_notify_dedupe</code></p>
  <details><summary>Exact event timeline and safe details</summary><div class="table-wrap"><table><thead><tr><th>Client time</th><th>Event</th><th>Delta</th><th>Duration</th><th>Status</th><th>Reason</th><th>Details</th></tr></thead><tbody>{_trace_timeline_html(trace_events)}</tbody></table></div></details>
</article>""")
        return "".join(cards) or '<p class="empty">No message trace captured in this direction.</p>'

    summary = analytics.get("summary") or {}
    coverage = "".join(
        f'<span class="coverage {"yes" if available else "no"}">{"CAPTURED" if available else "NOT CAPTURED"} · {_html(metric)}</span>'
        for metric, available in (analytics.get("coverage") or {}).items()
    )
    device_cards = "".join(
        f'<li><b>{_html(device.get("device_key"))}</b> — {_html(device.get("os"))} / {_html(device.get("browser"))} / {_html(device.get("runtime_kind"))} / {_html(device.get("frontend_version"))}</li>'
        for device in snapshot.get("devices") or []
    ) or "<li>No device captured.</li>"
    management_items = "".join(f"<li>{_html(item)}</li>" for item in interpretation.get("management_summary") or []) or "<li>No management conclusion available.</li>"
    technical_items = "".join(f"<li>{_html(item)}</li>" for item in interpretation.get("technical_analysis") or []) or "<li>No technical conclusion available.</li>"
    limitation_items = "".join(f"<li>{_html(item)}</li>" for item in interpretation.get("limitations") or [])
    reference_rows = "".join(
        f"<tr><td>{_html(kind)}</td><td><code>{_html(item.get('path'))}</code></td><td>{_html(item.get('title') or item.get('component'))}</td><td>{_html(item.get('reason'))}</td></tr>"
        for kind, items in (("Code", interpretation.get("related_files") or []), ("Document", interpretation.get("related_documents") or []))
        for item in items
    ) or '<tr><td colspan="4">No reference mapping available.</td></tr>'
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DevLog {_html(manifest.get('case_id'))}</title>
<style>
:root{{--bg:#07111d;--panel:#101d2b;--text:#eaf2ff;--muted:#9fb0c5;--green:#66e2a7;--orange:#ffbd66;--red:#ff7b72;--line:#2b3b4f}}*{{box-sizing:border-box}}body{{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 Inter,Segoe UI,Arial,sans-serif}}main{{max-width:1500px;margin:auto;padding:24px}}h1,h2,h3{{margin:.2em 0}}code{{overflow-wrap:anywhere}}.hero,.message-card,.overview{{border:1px solid var(--line);border-radius:16px;background:var(--panel);padding:18px;margin-bottom:18px}}.hero-grid{{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-top:14px}}.metric{{padding:12px;border-radius:10px;background:#162536}}.metric b{{display:block;font-size:24px}}.muted,.ids,.message-card>header>span{{color:var(--muted)}}.analysis-grid{{display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:14px}}.analysis-box{{padding:14px;border:1px solid var(--line);border-radius:12px;background:#162536}}.analysis-meta{{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0}}.analysis-meta span{{padding:5px 8px;border-radius:999px;background:#1f3550}}.next-action{{padding:12px;border-left:4px solid var(--orange);background:#2b2418}}.coverage-list{{display:flex;flex-wrap:wrap;gap:7px}}.coverage{{padding:5px 8px;border-radius:999px;font-size:11px}}.coverage.yes{{color:var(--green);background:#123526}}.coverage.no{{color:var(--orange);background:#3a2b13}}.message-card>header{{display:flex;justify-content:space-between;gap:14px;align-items:center}}.direction{{display:inline-block;padding:3px 7px;border-radius:6px;background:#1f3550;color:#9ad5ff;font-size:11px;font-weight:700}}.message-card.incoming .direction{{background:#15392b;color:var(--green)}}.mermaid-wrap,.table-wrap{{overflow:auto;margin-top:12px;padding:10px;border-radius:10px;background:#fff;color:#111}}.mermaid{{min-width:1100px}}table{{width:100%;border-collapse:collapse;font-size:12px}}th,td{{padding:7px;border:1px solid #ccd3dd;text-align:left;vertical-align:top}}td code{{white-space:pre-wrap}}.flags{{padding:9px;border-left:4px solid var(--orange);background:#2b2418}}.ordering{{padding:9px;border-left:4px solid #60a5fa;background:#152943}}.worker{{padding:9px;border-left:4px solid var(--green);background:#123526}}details summary{{cursor:pointer;font-weight:700}}.empty{{color:var(--muted)}}@media print{{body{{background:#fff;color:#111}}main{{max-width:none;padding:0}}.hero,.message-card,.overview{{break-inside:avoid;border-color:#bbb;background:#fff}}details{{display:block}}details>summary{{display:none}}details>*{{display:block!important}}.mermaid-wrap{{overflow:visible}}}}
</style>
<script type="module">import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';mermaid.initialize({{startOnLoad:true,securityLevel:'strict',theme:'neutral',flowchart:{{htmlLabels:true,useMaxWidth:false}}}});</script>
</head><body><main>
<section class="hero"><h1>DevLog Visual Message Path</h1><p class="muted">Case {_html(manifest.get('case_id'))} · User {_html(manifest.get('user_label') or manifest.get('user_id'))} · Exported {_html(snapshot.get('exported_at'))}</p>
<div class="hero-grid"><div class="metric">Events<b>{_html(summary.get('event_count'))}</b></div><div class="metric">Outgoing<b>{_html(summary.get('outgoing_send_trace_count'))}</b></div><div class="metric">Incoming<b>{_html(summary.get('observed_incoming_trace_count'))}</b></div><div class="metric">Devices<b>{_html(summary.get('device_count'))}</b></div><div class="metric">Attention flags<b>{_html(summary.get('attention_flag_count'))}</b></div><div class="metric">Ordering notes<b>{_html(summary.get('ordering_note_count'))}</b></div></div></section>
<section class="overview"><h2>Deterministic case analysis</h2><div class="analysis-meta"><span>Snapshot: {_html(interpretation.get('snapshot_status'))}</span><span>Classification: {_html(interpretation.get('classification'))}</span><span>Severity: {_html(interpretation.get('severity'))}</span><span>Confidence: {_html(interpretation.get('confidence'))}</span></div><p class="muted">{_html(interpretation.get('confidence_basis'))}</p><div class="analysis-grid"><div class="analysis-box"><h3>Management analysis</h3><ul>{management_items}</ul></div><div class="analysis-box"><h3>Technical analysis</h3><ul>{technical_items}</ul></div></div><p class="next-action"><b>Next diagnostic action:</b> {_html(interpretation.get('next_diagnostic_action'))}</p><details><summary>Related code files, documents and limitations</summary><div class="table-wrap"><table><thead><tr><th>Type</th><th>Path</th><th>Component / title</th><th>Reason</th></tr></thead><tbody>{reference_rows}</tbody></table></div><h3>Limitations</h3><ul>{limitation_items}</ul></details></section>
<section class="overview"><h2>Evidence coverage</h2><p class="muted">NOT CAPTURED means no matching DevLog event or Worker outcome exists; it does not mean the product state did not happen.</p><div class="coverage-list">{coverage}</div><h2>Devices</h2><ul>{device_cards}</ul></section>
<h2>Sent messages — one graph per message</h2>{trace_cards(outgoing, 'outgoing')}
<h2>Received messages — one graph per message</h2>{trace_cards(incoming, 'incoming')}
<section class="overview"><h2>Legend and interpretation</h2><ul><li>Green: captured stage.</li><li>Gray dashed: stage was not captured.</li><li>Blue: valid ordering note, not an error.</li><li>Yellow: largest measured segment, a bottleneck candidate only—not proof of root cause.</li><li>Red: deterministic error/attention evidence from the trace.</li><li>Backend RPC/Saved/Post values are cumulative from backend send entry; edge labels show available deltas.</li></ul></section>
</main></body></html>"""


@devlog_bp.get("/api/console/devlog/cases/<case_id>/export")
@require_capability("console.view_user_devlog")
def export_devlog_case(case_id: str):
    export_format = str(request.args.get("format") or "json").strip().lower()
    manifest = _read_manifest(case_id)
    if not manifest:
        return jsonify({"status": "not_found"}), 404
    events, devices = _load_case_events(case_id)
    artifacts = _list_artifacts(case_id)
    notification_evidence = _load_notification_evidence(events)
    analytics = _build_case_analytics(events, devices, notification_evidence, manifest)
    snapshot = {
        "schema_version": 1,
        "exported_at": _utc_iso(),
        "manifest": manifest,
        "countdown": _countdown_state(manifest),
        "devices": devices,
        "artifacts": artifacts,
        "notification_evidence": notification_evidence,
        "analytics": analytics,
        "events": events,
    }
    filename = f"devlog-{case_id}.{export_format}"

    if export_format == "json":
        body = json.dumps(snapshot, ensure_ascii=False, indent=2, sort_keys=True)
        mimetype = "application/json"
    elif export_format == "csv":
        output = io.StringIO()
        rows = [*_analytics_csv_rows(analytics), *[_flatten_event(event) for event in events]]
        fieldnames: list[str] = []
        for row in rows:
            for key in row:
                if key not in fieldnames:
                    fieldnames.append(key)
        writer = csv.DictWriter(output, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)
        body = output.getvalue()
        mimetype = "text/csv"
    elif export_format in {"html", "htm"}:
        body = _build_html_export(snapshot)
        mimetype = "text/html"
        filename = f"devlog-{case_id}.html"
    elif export_format in {"md", "markdown"}:
        summary = analytics["summary"]
        latency_stats = analytics["latency_stats"]
        interpretation = analytics.get("interpretation") or {}
        lines = [
            f"# DevLog Case {case_id}",
            "",
            f"- User: `{manifest.get('user_label') or manifest.get('user_id')}`",
            f"- Status: `{manifest.get('status')}`",
            f"- Capture: `{manifest.get('capture_started_at')}` → `{manifest.get('capture_expires_at')}`",
            f"- Exported: `{snapshot['exported_at']}`",
            f"- Events: `{len(events)}`",
            f"- Devices: `{len(devices)}`",
            f"- Retention: `{snapshot['countdown']['label']}`",
            "",
            "## Deterministic Case Analysis",
            "",
            f"- Snapshot: `{interpretation.get('snapshot_status')}`",
            f"- Classification: `{interpretation.get('classification')}`",
            f"- Severity: `{interpretation.get('severity')}`",
            f"- Confidence: `{interpretation.get('confidence')}` — {interpretation.get('confidence_basis')}",
            "",
            "### Management Analysis",
            "",
        ]
        lines.extend([f"- {item}" for item in interpretation.get("management_summary") or []] or ["- No management conclusion available."])
        lines.extend(["", "### Technical Analysis", ""])
        lines.extend([f"- {item}" for item in interpretation.get("technical_analysis") or []] or ["- No technical conclusion available."])
        lines.extend([
            "",
            f"### Next Diagnostic Action",
            "",
            str(interpretation.get("next_diagnostic_action") or "No next action computed."),
            "",
            "### Related Code Files",
            "",
        ])
        lines.extend([
            f"- `{item.get('path')}` — {item.get('component')}: {item.get('reason')}"
            for item in interpretation.get("related_files") or []
        ] or ["- No related code file mapped."])
        lines.extend(["", "### Related Documents", ""])
        lines.extend([
            f"- `{item.get('path')}` — {item.get('title')}"
            for item in interpretation.get("related_documents") or []
        ] or ["- No related document mapped."])
        lines.extend(["", "### Analysis Limitations", ""])
        lines.extend([f"- {item}" for item in interpretation.get("limitations") or []])
        lines.extend([
            "",
            "## Computed Analysis",
            "",
            f"- Traces: `{summary['trace_count']}`; outgoing sends: `{summary['outgoing_send_trace_count']}`; observed incoming/realtime: `{summary['observed_incoming_trace_count']}`",
            f"- Attention flags: `{summary['attention_flag_count']}`",
            f"- Ordering notes: `{summary['ordering_note_count']}`",
            f"- Reconcile: replace=`{analytics['reconcile_totals']['replace']}`, insert=`{analytics['reconcile_totals']['insert']}`",
            f"- Identity matcher: matched=`{analytics['identity_match_totals']['matched']}`, not matched=`{analytics['identity_match_totals']['not_matched']}`",
            "",
            "### Latency Summary",
            "",
            "| Metric | Count | Min ms | Avg ms | Median ms | P95 ms | Max ms |",
            "|---|---:|---:|---:|---:|---:|---:|",
        ])
        lines.extend([
            f"| `{metric}` | {stats.get('count')} | {stats.get('min_ms')} | {stats.get('avg_ms')} | {stats.get('median_ms')} | {stats.get('p95_ms')} | {stats.get('max_ms')} |"
            for metric, stats in latency_stats.items()
        ])
        lines.extend([
            "",
            "### Coverage",
            "",
        ])
        lines.extend([f"- {'CAPTURED' if available else 'NOT CAPTURED'} — `{metric}`" for metric, available in analytics["coverage"].items()])
        lines.extend([
            "",
            "### Notification Worker Evidence",
            "",
            f"- Source: `message_notify_dedupe`; query available: `{analytics['notification_worker']['evidence_available']}`; query latency: `{analytics['notification_worker'].get('query_latency_ms')}` ms; reason: `{analytics['notification_worker'].get('reason_code') or '—'}`",
            f"- Outcomes: `{json.dumps(analytics['notification_worker'].get('counts') or {}, sort_keys=True)}`",
            "",
            "| Message | Recipient | Route | State | Retry count | Created → Sent ms | Error code |",
            "|---|---|---|---|---:|---:|---|",
        ])
        lines.extend([
            f"| `{row.get('message_id')}` | `{row.get('recipient_user_id')}` | {row.get('route_selected')} | {row.get('notify_state')} | {row.get('attempts')} | {row.get('created_to_sent_ms')} | {row.get('last_error_code') or '—'} |"
            for row in notification_evidence.get("rows") or []
        ] or ["| — | — | — | No matching Worker outcome | — | — | — |"])
        lines.extend([
            "",
            "### Per-trace Sequence and Latency",
            "",
            "| Trace | Kind | HTTP ACK ms | Canonical ms | Delivered ms | Read ms | RPC ms | Saved ms | Post ms | Replace | Insert | Flags |",
            "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|",
        ])
        lines.extend([
            "| `{trace}` | {kind} | {http} | {canonical} | {delivered} | {read} | {rpc} | {saved} | {post} | {replace} | {insert} | {flags} |".format(
                trace=trace.get("trace_id"),
                kind=trace.get("kind"),
                http=(trace.get("latency") or {}).get("http_start_to_ack_ms"),
                canonical=(trace.get("latency") or {}).get("http_start_to_canonical_ms"),
                delivered=(trace.get("latency") or {}).get("http_start_to_delivered_observed_ms"),
                read=(trace.get("latency") or {}).get("http_start_to_read_observed_ms"),
                rpc=(trace.get("latency") or {}).get("backend_rpc_cumulative_ms"),
                saved=(trace.get("latency") or {}).get("backend_saved_cumulative_ms"),
                post=(trace.get("latency") or {}).get("backend_post_processing_cumulative_ms"),
                replace=(trace.get("reconcile") or {}).get("replace"),
                insert=(trace.get("reconcile") or {}).get("insert"),
                flags=", ".join([
                    *[f"attention:{flag}" for flag in trace.get("attention_flags") or []],
                    *[f"ordering:{note}" for note in trace.get("ordering_notes") or []],
                    *[f"gap:{gap}" for gap in trace.get("evidence_gaps") or []],
                ]) or "—",
            )
            for trace in analytics["traces"]
        ] or ["| — | No traces | — | — | — | — | — | — | — | — | — | — |"])
        lines.extend([
            "",
            "## Devices",
            "",
        ])
        lines.extend([f"- `{item.get('device_key')}` — {item.get('os')} / {item.get('browser')} / {item.get('runtime_kind')}" for item in devices] or ["- No device events captured."])
        lines.extend(["", "## Notes", ""])
        lines.extend([f"- {note.get('created_at')}: {note.get('text')}" for note in manifest.get("notes") or []] or ["- No notes."])
        lines.extend(["", "## Timeline", ""])
        lines.extend([
            f"- `{event.get('server_received_at') or event.get('client_wall_at')}` `{event.get('event_code')}` trace=`{event.get('trace_id')}` status=`{event.get('status')}` reason=`{event.get('reason_code')}`"
            for event in events
        ] or ["- No events captured."])
        lines.extend(["", "## Artifacts", ""])
        lines.extend([f"- `{artifact.get('name')}` ({artifact.get('size')} bytes)" for artifact in artifacts] or ["- No artifacts."])
        body = "\n".join(lines) + "\n"
        mimetype = "text/markdown"
        filename = f"devlog-{case_id}.md"
    else:
        return jsonify({"status": "error", "message": "format must be json, csv, md or html."}), 400

    response = Response(body, mimetype=mimetype)
    response.headers["Content-Disposition"] = f'attachment; filename="{filename}"'
    response.headers["X-DevLog-Case-Id"] = case_id
    return response
