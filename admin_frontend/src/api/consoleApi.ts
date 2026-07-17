// FILE: ~/otmega/otmega_app/console/admin_frontend/src/api/consoleApi.ts
// ماموریت: کلاینت REST برای health، session، config و APIهای read-only کنسول.

export type ConsoleHealth = {
  status: string;
  service: string;
  mode: string;
  write_enabled: boolean;
  timestamp: string;
};

export type ConsoleSession = {
  status: string;
  mode: string;
  write_enabled: boolean;
  login_enabled: boolean;
  actor: {
    authenticated: boolean;
    bearer_present: boolean;
    user_id: string | null;
    email: string | null;
    full_name: string | null;
    title: string | null;
    avatar_url: string | null;
    avatar_path: string | null;
    balance: string;
    country_code: string | null;
    online_status: string;
    last_typed_lang: string;
    tier: number;
    role: string;
    access_level: string;
    is_user_zero: boolean;
    profile_source: string;
    advisor_id: number | null;
  };
  capabilities: string[];
};

export type ConfigDomain = {
  key: string;
  source: string;
  write_enabled: boolean;
};

export type ConfigDomainsResponse = {
  status: string;
  mode: string;
  domains: ConfigDomain[];
};

export type ConsoleDashboardSettings = Record<string, unknown>;

export type ConsoleDashboardSettingsResponse = {
  status: string;
  bucket: string;
  path: string;
  actor_key: string;
  settings: ConsoleDashboardSettings;
  updated_at: string | null;
};

export type OperationalMetric = {
  label: string;
  value: string;
  state: 'ok' | 'warn' | 'error' | 'neutral' | 'unknown';
};

export type OperationalLink = {
  label: string;
  url: string;
};

export type OperationalResource = {
  id: string;
  group: string;
  name: string;
  kind: string;
  status: 'ok' | 'warn' | 'error' | 'unknown';
  summary: string;
  primary_url: string | null;
  console_url: string | null;
  latency_ms: number | null;
  metrics: OperationalMetric[];
  links: OperationalLink[];
  checked_at: string;
};

export type OperationalResourcesResponse = {
  status: string;
  mode: string;
  write_enabled: boolean;
  timestamp: string;
  resources: OperationalResource[];
};

export type FirebaseHostingRelease = {
  name: string;
  type: string;
  release_time: string | null;
  release_user_email: string | null;
  version: string;
  version_status: string;
  file_count: string;
  version_bytes: string;
  create_time: string | null;
  finalize_time: string | null;
  deployment_tool: string | null;
};

export type FirebaseHostingReleasesResponse = {
  status: string;
  mode: string;
  write_enabled: boolean;
  project_id: string;
  site_id: string;
  primary_url: string;
  console_url: string;
  http_status: number;
  latency_ms: number;
  timestamp: string;
  releases: FirebaseHostingRelease[];
};

export type CloudRunLogEntry = {
  timestamp: string | null;
  receive_timestamp: string | null;
  severity: string;
  message: string;
  log_name: string;
  insert_id: string;
  revision: string;
  service: string;
  location: string;
  http_method: string | null;
  request_url: string | null;
  status: number | null;
  latency: string | null;
  event?: string;
  build_status?: string;
  artifact_digest?: string | null;
};

export type CloudRunLogsResponse = {
  status: string;
  mode: string;
  write_enabled: boolean;
  source: string;
  project_id: string;
  region: string;
  service: string;
  hours: number;
  severity: string;
  limit: number;
  http_status?: number;
  latency_ms?: number;
  message?: string;
  timestamp: string;
  entries: CloudRunLogEntry[];
};

export type OperationalLogSource = 'cloud-run-console' | 'cloud-build';

export type SupabaseStatusIncident = {
  name?: string;
  status?: string;
  impact?: string;
  shortlink?: string;
  updated_at?: string;
};

export type SupabaseStatusResponse = {
  status: string;
  http_status?: number;
  latency_ms?: number;
  indicator?: string | null;
  description?: string | null;
  incidents: SupabaseStatusIncident[];
  scheduled_maintenances: SupabaseStatusIncident[];
  checked_at: string;
  source_url: string;
  message?: string;
};

export type SupabaseOverviewTable = {
  name: string;
  status: 'ok' | 'warn' | 'error';
  http_status: number | null;
  latency_ms: number | null;
  row_count: number | null;
  content_range: string | null;
  notes: string;
  documented_field_count: number;
  documented_fields: string[];
  documented_indexes: string[];
};

export type SupabaseDatabaseOverviewResponse = {
  status: 'ok' | 'warn' | 'error';
  project: {
    url: string;
    project_id: string;
    dashboard_url: string | null;
    advisor_id: number;
  };
  tables: SupabaseOverviewTable[];
  checklist: string[];
  errors: string[];
  latency_ms: number;
  checked_at: string;
};

export type SupabaseLipWf1AuditRow = {
  created_at: string | null;
  message_id: string;
  conversation_id: string;
  sender: { user_id: string; email: string | null; full_name: string | null };
  recipients: Array<{ user_id: string | null; email: string | null; full_name: string | null; target_lang: string | null; target_lang_source?: string | null; target_index: number }>;
  source_lang: string | null;
  target_langs: string[];
  data_kind: string;
  status: string | null;
  content_original: string | null;
  content_pivot: string | null;
  text_translations: Record<string, string> | null;
  requested_model: string | null;
  actual_model: string | null;
  requested_provider: string | null;
  actual_provider: string | null;
  used_fallback: boolean | null;
  selection_reason: string | null;
  language_phase: string | null;
  raw_fields: Record<string, unknown>;
};

export type SupabaseLipWf1AuditResponse = {
  status: string;
  http_status: number;
  latency_ms: number;
  filters: Record<string, string | number | null>;
  rows: SupabaseLipWf1AuditRow[];
  checked_at: string;
};

export type UserOpsBannerTarget = {
  user_id: string;
  email: string | null;
  full_name: string | null;
  online_status: string | null;
  avatar_path?: string | null;
  avatar_url?: string | null;
  country_code?: string | null;
  role?: string | null;
  source?: string;
  state?: string;
  has_chat?: boolean;
  shown?: boolean;
  repairable?: boolean;
  repair_block_reason?: string | null;
};

export type UserOpsRow = {
  user_id: string;
  advisor_id: number;
  email: string | null;
  full_name: string | null;
  role: string;
  access_level: string;
  tier: number;
  balance: string;
  country_code: string | null;
  avatar_path: string | null;
  avatar_url: string | null;
  online_status: string;
  last_typed_lang: string | null;
  joined_at: string | null;
  status: string;
  visibility: {
    profile_visibility: string | null;
    updated_at: string | null;
    visibility_changed_at: string | null;
    active_banner_count: number;
    stored_active_relation_count?: number;
    visible_banner_count?: number;
    chat_banner_count?: number;
    required_banner_count?: number;
    upstream_system_banner_count?: number;
    invitation_banner_count?: number;
    warmable_chat_count?: number;
    excluded_banner_count?: number;
    pending_banner_count: number;
    removed_banner_count: number;
    hidden_viewer_count: number;
    active_targets: UserOpsBannerTarget[];
    visible_now_targets?: UserOpsBannerTarget[];
    warmable_chat_targets?: UserOpsBannerTarget[];
    excluded_targets?: UserOpsBannerTarget[];
  };
  notifications: {
    system_notification_tokens: number;
    internal_notification_markers: number;
    device_entries: number;
  };
  usage: {
    messages_sent: number;
    last_message_at: string | null;
    last_message_latency_seconds: number | null;
    conversations: {
      total: number;
      active_with_chat: number;
      active_without_chat: number;
      unread_total: number;
      banner_list_with_chat?: number;
      upstream_system_with_chat?: number;
    };
    notifications: {
      system_push_total: number;
      internal_total: number;
    };
  };
};

export type UserOpsResponse = {
  status: string;
  mode: string;
  write_enabled: boolean;
  timestamp: string;
  page: number;
  page_size: number;
  total: number;
  sort: string;
  direction: string;
  filters: Record<string, string>;
  rows: UserOpsRow[];
};

export type UserOpsAvatarUrlResponse = {
  status: string;
  avatar_path: string;
  avatar_url: string | null;
};

export type UserOpsRepairResponse = {
  status: string;
  mode: string;
  write_enabled: boolean;
  audit: {
    event: string;
    actor_email: string | null;
    actor_user_id: string | null;
    owner_user_id: string;
    counterpart_user_id: string;
    reason: string;
    timestamp: string;
  };
  repair: {
    owner_user_id: string;
    counterpart_user_id: string;
    before_active_count: number;
    after_active_count: number;
    removed_marker_cleared: boolean;
    visibility_changed_at: string;
    target: UserOpsBannerTarget;
  };
};

export type DevLogCountdown = {
  capture_remaining_seconds: number;
  retention_started: boolean;
  retention_remaining_seconds: number | null;
  expired: boolean;
  label: string;
};

export type DevLogManifest = {
  schema_version: number;
  case_id: string;
  user_id: string;
  user_label: string;
  title: string;
  status: 'active' | 'stopped' | string;
  capture_started_at: string;
  capture_expires_at: string;
  capture_minutes: number;
  retention_days: number;
  retention_started_at: string | null;
  first_download_at: string | null;
  expires_at: string | null;
  created_at: string;
  notes: Array<{ note_id: string; text: string; created_at: string; created_by: string }>;
};

export type DevLogDevice = {
  device_session_ref: string;
  device_key: string;
  os: string;
  browser: string;
  runtime_kind: string;
  native_platform: string;
  frontend_version: string;
};

export type DevLogEvent = {
  event_id: string;
  event_code: string;
  trace_id: string;
  client_message_id: string | null;
  message_id: string | null;
  conversation_id: string | null;
  source: string;
  client_wall_at: string | null;
  server_received_at: string;
  duration_ms: number | null;
  status: string | null;
  reason_code: string | null;
  details: Record<string, unknown>;
  device: DevLogDevice;
};

export type DevLogArtifact = {
  path: string;
  name: string;
  size: number;
  content_type: string | null;
  updated_at: string | null;
};

export type DevLogLatencyStats = {
  count: number;
  min_ms: number | null;
  avg_ms: number | null;
  median_ms: number | null;
  p95_ms: number | null;
  max_ms: number | null;
};

export type DevLogTraceAnalysis = {
  trace_id: string;
  kind: 'outgoing_send' | 'observed_incoming_or_realtime' | 'auxiliary' | string;
  client_message_id: string | null;
  message_id: string | null;
  conversation_id: string | null;
  device_session_ref: string;
  event_count: number;
  canonical_observation_count: number;
  reconcile: { replace: number; insert: number; other: number };
  identity_match: { matched: number; not_matched: number };
  latency: Record<string, number | null>;
  attention_flags: string[];
  ordering_notes: string[];
  evidence_gaps: string[];
  event_sequence: string[];
  notification_worker: {
    outcome_count: number;
    states: Record<string, number>;
    rows: DevLogNotificationEvidenceRow[];
  };
};

export type DevLogNotificationEvidenceRow = {
  advisor_id: number | null;
  message_id: string;
  recipient_user_id: string;
  route_selected: string | null;
  notify_state: string;
  created_at: string | null;
  sent_at: string | null;
  attempts: number | null;
  last_attempt_at: string | null;
  last_error_code: string | null;
  created_to_sent_ms: number | null;
};

export type DevLogNotificationEvidence = {
  available: boolean;
  source: string;
  queried_at?: string;
  query_latency_ms?: number;
  reason_code?: string | null;
  counts: Record<string, number>;
  rows: DevLogNotificationEvidenceRow[];
};

export type DevLogCaseInterpretation = {
  analysis_version: number;
  generated_at: string;
  snapshot_status: string;
  classification: string;
  severity: string;
  confidence: 'low' | 'medium' | 'high';
  confidence_basis: string;
  management_summary: string[];
  technical_analysis: string[];
  captured_evidence: string[];
  missing_evidence: string[];
  data_quality: {
    collector_ingest_delay_ms: DevLogLatencyStats & { interpretation: string };
  };
  related_files: Array<{ path: string; component: string; reason: string }>;
  related_documents: Array<{ path: string; title: string }>;
  next_diagnostic_action: string;
  limitations: string[];
};

export type DevLogAnalytics = {
  schema_version: number;
  computed_at: string;
  summary: {
    event_count: number;
    trace_count: number;
    device_count: number;
    outgoing_send_trace_count: number;
    outgoing_complete_trace_count: number;
    outgoing_partial_trace_count: number;
    observed_incoming_trace_count: number;
    auxiliary_trace_count: number;
    attention_flag_count: number;
    ordering_note_count: number;
    worker_notification_outcome_count: number;
  };
  latency_stats: Record<string, DevLogLatencyStats>;
  coverage: Record<string, boolean>;
  reconcile_totals: { replace: number; insert: number; other: number };
  identity_match_totals: { matched: number; not_matched: number };
  event_code_counts: Record<string, number>;
  source_counts: Record<string, number>;
  attention_flags: string[];
  ordering_notes: string[];
  notification_worker: {
    evidence_available: boolean;
    source: string | null;
    query_latency_ms: number | null;
    reason_code: string | null;
    counts: Record<string, number>;
  };
  interpretation: DevLogCaseInterpretation;
  traces: DevLogTraceAnalysis[];
};

export type DevLogCase = {
  manifest: DevLogManifest;
  countdown: DevLogCountdown;
  events: DevLogEvent[];
  devices: DevLogDevice[];
  artifacts: DevLogArtifact[];
  notification_evidence: DevLogNotificationEvidence;
  analytics: DevLogAnalytics;
  event_count: number;
  storage_path: string;
};

export type DevLogCasesResponse = {
  status: string;
  bucket: string;
  root: string;
  cleaned_expired_cases: number;
  cases: Array<DevLogManifest & { countdown: DevLogCountdown }>;
};

export type DevLogCaseResponse = {
  status: string;
  case: DevLogCase;
};

export type UiTextsMatrixRow = {
  key: string;
  category: string;
  subcategory: string;
  values: Record<string, string>;
  missing_languages: string[];
  orphan: boolean;
};

export type UiTextsLanguageSummary = {
  code: string;
  key_count: number;
  runtime_key_count: number | null;
  fallback_key_count: number;
  missing_from_english: string[];
  missing_from_language: string[];
  runtime_source: string;
  runtime_updated_at: string | null;
  source_file: string;
};

export type UiTextsMatrix = {
  languages: string[];
  rows: UiTextsMatrixRow[];
  language_summaries: UiTextsLanguageSummary[];
  source: string;
  write_enabled: boolean;
  gcs_enabled: boolean;
  ai_suggestions_enabled: boolean;
};

export type UiTextsMatrixResponse = {
  status: string;
  matrix: UiTextsMatrix;
};

export type UiTextsPatchFile = {
  language: string;
  filename: string;
  content: string;
};

export type UiTextsPatchResponse = {
  status: string;
  write_enabled: boolean;
  sql_patch: string;
  python_files: UiTextsPatchFile[];
  changed_language_count: number;
  changed_key_count: number;
};

export type UiTextsApplyResponse = {
  status: string;
  write_enabled: boolean;
  applied_language_count: number;
  applied_languages: string[];
  changed_key_count: number;
  python_files: Array<{
    language: string;
    filename: string;
    path: string;
    key_count: number;
  }>;
};

export type UiTextsLlmOption = {
  key: string;
  label: string;
  provider: string;
  product: string;
  model: string;
  api_key_env: string;
  transport: string;
  enabled: boolean;
  secret_available: boolean;
};

export type UiTextsLlmOptionsResponse = {
  status: string;
  options: UiTextsLlmOption[];
  active_option_key: string;
  source: string;
};

export type UiTextsAiSuggestion = {
  key: string;
  language: string;
  text: string;
};

export type UiTextsAiSuggestionsResponse = {
  status: string;
  model_option_key: string;
  provider: string;
  model: string;
  requested_count: number;
  suggested_count: number;
  suggestions: UiTextsAiSuggestion[];
};

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, {
    credentials: 'include',
    headers: {
      Accept: 'application/json',
    },
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(payload?.message || `${path} failed with ${response.status}`);
  }
  return response.json() as Promise<T>;
}

async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    method: 'POST',
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(payload?.message || `${path} failed with ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export function fetchConsoleHealth(): Promise<ConsoleHealth> {
  return getJson<ConsoleHealth>('/api/console/health');
}

export function fetchConsoleSession(): Promise<ConsoleSession> {
  return getJson<ConsoleSession>('/api/console/session');
}

export function loginConsole(email: string, password: string): Promise<ConsoleSession> {
  return postJson<ConsoleSession>('/api/console/login', { email, password });
}

export function logoutConsole(): Promise<ConsoleSession> {
  return postJson<ConsoleSession>('/api/console/logout');
}

export function fetchConfigDomains(): Promise<ConfigDomainsResponse> {
  return getJson<ConfigDomainsResponse>('/api/console/config/domains');
}

export function fetchConsoleDashboardSettings(): Promise<ConsoleDashboardSettingsResponse> {
  return getJson<ConsoleDashboardSettingsResponse>('/api/console/dashboard-settings');
}

export function saveConsoleDashboardSettingsSection(section: string, value: Record<string, unknown>): Promise<ConsoleDashboardSettingsResponse> {
  return postJson<ConsoleDashboardSettingsResponse>('/api/console/dashboard-settings', { section, value });
}

export function fetchOperationalResources(): Promise<OperationalResourcesResponse> {
  return getJson<OperationalResourcesResponse>('/api/console/operations/resources');
}

export function fetchFirebaseHostingReleases(limit = 10): Promise<FirebaseHostingReleasesResponse> {
  return getJson<FirebaseHostingReleasesResponse>(`/api/console/operations/firebase-hosting/releases?limit=${limit}`);
}

export function fetchOperationalLogs(params: { source: OperationalLogSource; hours: number; severity: string; limit: number }): Promise<CloudRunLogsResponse> {
  const query = new URLSearchParams({
    hours: String(params.hours),
    limit: String(params.limit),
    severity: params.severity,
    source: params.source,
  });
  return getJson<CloudRunLogsResponse>(`/api/console/operations/logs?${query.toString()}`);
}

export function fetchSupabaseStatus(): Promise<SupabaseStatusResponse> {
  return getJson<SupabaseStatusResponse>('/api/console/supabase/status');
}

export function fetchSupabaseDatabaseOverview(): Promise<SupabaseDatabaseOverviewResponse> {
  return getJson<SupabaseDatabaseOverviewResponse>('/api/console/supabase/database-overview');
}

export function fetchSupabaseLipWf1Audit(params: {
  advisor_id: number;
  limit: number;
  conversation_id?: string;
  created_at_from?: string;
  created_at_to?: string;
}): Promise<SupabaseLipWf1AuditResponse> {
  const query = new URLSearchParams({
    advisor_id: String(params.advisor_id),
    limit: String(params.limit),
  });
  if (params.conversation_id) query.set('conversation_id', params.conversation_id);
  if (params.created_at_from) query.set('created_at_from', params.created_at_from);
  if (params.created_at_to) query.set('created_at_to', params.created_at_to);
  return getJson<SupabaseLipWf1AuditResponse>(`/api/console/supabase/lip-wf1-audit?${query.toString()}`);
}

export function fetchCloudRunLogs(params: { hours: number; severity: string; limit: number }): Promise<CloudRunLogsResponse> {
  return fetchOperationalLogs({ ...params, source: 'cloud-run-console' });
}

export function fetchUserOperations(params: {
  page: number;
  page_size: number;
  sort: string;
  direction: string;
  search: string;
  role: string;
  status: string;
  online_status: string;
}): Promise<UserOpsResponse> {
  const query = new URLSearchParams({
    page: String(params.page),
    page_size: String(params.page_size),
    sort: params.sort,
    direction: params.direction,
    search: params.search,
    role: params.role,
    status: params.status,
    online_status: params.online_status,
  });
  return getJson<UserOpsResponse>(`/api/console/users/operations?${query.toString()}`);
}

export function getUserOpsAvatarUrl(avatarPath: string): Promise<UserOpsAvatarUrlResponse> {
  return postJson<UserOpsAvatarUrlResponse>('/api/console/users/avatar-url', { avatar_path: avatarPath });
}

export function repairUserOpsActiveBanner(params: {
  owner_user_id: string;
  counterpart_user_id: string;
  reason?: string;
}): Promise<UserOpsRepairResponse> {
  return postJson<UserOpsRepairResponse>('/api/console/users/repair-active-banner', {
    owner_user_id: params.owner_user_id,
    counterpart_user_id: params.counterpart_user_id,
    confirmation: 'REPAIR',
    reason: params.reason || 'user_operations_banner_popup_repair',
  });
}

export type UserOpsUnreadConversation = {
  conversation_id: string;
  unread_count: number;
  delivered_unread: number;
  stuck_sent: number;
  legacy_inconsistent: number;
  counterparts: string[];
};

export type UserOpsUnreadTotals = {
  unread_count_total: number;
  delivered_unread_total: number;
  stuck_sent_total: number;
  legacy_inconsistent_total: number;
  worker_badge_formula_total: number;
};

export type UserOpsUnreadDiagnosticsResponse = {
  status: string;
  mode?: string;
  message?: string;
  timestamp?: string;
  user_id?: string;
  totals: UserOpsUnreadTotals;
  conversations: UserOpsUnreadConversation[];
  results?: Array<{ conversation_id: string; action: string; messages_marked_read: number; participant_rows: number }>;
};

export function fetchUserUnreadDiagnostics(userId: string): Promise<UserOpsUnreadDiagnosticsResponse> {
  return getJson<UserOpsUnreadDiagnosticsResponse>(`/api/console/users/${encodeURIComponent(userId)}/unread-diagnostics`);
}

export function repairUserUnread(params: {
  user_id: string;
  conversation_id: string;
  action: 'mark_read_and_sync' | 'set_unread';
  value?: number;
}): Promise<UserOpsUnreadDiagnosticsResponse> {
  return postJson<UserOpsUnreadDiagnosticsResponse>('/api/console/users/repair-unread', {
    user_id: params.user_id,
    conversation_id: params.conversation_id,
    action: params.action,
    value: params.value,
    confirmation: 'REPAIR',
  });
}

export function fetchDevLogCases(userId: string): Promise<DevLogCasesResponse> {
  return getJson<DevLogCasesResponse>(`/api/console/devlog/cases?user_id=${encodeURIComponent(userId)}`);
}

export function createDevLogCase(payload: {
  user_id: string;
  user_label: string;
  capture_minutes: number;
  retention_days: number;
}): Promise<DevLogCaseResponse> {
  return postJson<DevLogCaseResponse>('/api/console/devlog/cases', payload);
}

export function fetchDevLogCase(caseId: string): Promise<DevLogCaseResponse> {
  return getJson<DevLogCaseResponse>(`/api/console/devlog/cases/${encodeURIComponent(caseId)}`);
}

export function stopDevLogCase(caseId: string): Promise<DevLogCaseResponse> {
  return postJson<DevLogCaseResponse>(`/api/console/devlog/cases/${encodeURIComponent(caseId)}/stop`);
}

export function confirmDevLogDownload(caseId: string): Promise<DevLogCaseResponse> {
  return postJson<DevLogCaseResponse>(`/api/console/devlog/cases/${encodeURIComponent(caseId)}/download-confirmed`);
}

export function startDevLogRetention(caseId: string): Promise<DevLogCaseResponse> {
  return postJson<DevLogCaseResponse>(`/api/console/devlog/cases/${encodeURIComponent(caseId)}/start-retention`);
}

export function addDevLogNote(caseId: string, text: string): Promise<DevLogCaseResponse> {
  return postJson<DevLogCaseResponse>(`/api/console/devlog/cases/${encodeURIComponent(caseId)}/notes`, { text });
}

export async function uploadDevLogArtifact(caseId: string, file: File): Promise<DevLogCaseResponse> {
  const body = new FormData();
  body.append('file', file);
  const response = await fetch(`/api/console/devlog/cases/${encodeURIComponent(caseId)}/artifacts`, {
    body,
    credentials: 'include',
    method: 'POST',
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(payload?.message || `Artifact upload failed with ${response.status}`);
  }
  return response.json() as Promise<DevLogCaseResponse>;
}

export async function downloadDevLogCaseExport(caseId: string, format: 'json' | 'csv' | 'md' | 'html'): Promise<void> {
  const response = await fetch(`/api/console/devlog/cases/${encodeURIComponent(caseId)}/export?format=${format}`, {
    credentials: 'include',
  });
  if (!response.ok) throw new Error(`DevLog ${format} export failed with ${response.status}`);
  const blob = await response.blob();
  const disposition = response.headers.get('Content-Disposition') || '';
  const filename = disposition.match(/filename="?([^";]+)"?/i)?.[1] || `devlog-${caseId}.${format}`;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  await confirmDevLogDownload(caseId);
}

export function fetchUiTextsMatrix(): Promise<UiTextsMatrixResponse> {
  return getJson<UiTextsMatrixResponse>('/api/console/ui-texts/matrix');
}

export function generateUiTextsPatch(payload: {
  changes: Record<string, Record<string, string>>;
  export_languages?: string[];
  matrix: Record<string, Record<string, string>>;
  ordered_keys: string[];
}): Promise<UiTextsPatchResponse> {
  return postJson<UiTextsPatchResponse>('/api/console/ui-texts/patch', payload);
}

export function applyUiTextsMatrix(payload: {
  changes: Record<string, Record<string, string>>;
  matrix: Record<string, Record<string, string>>;
  ordered_keys: string[];
}): Promise<UiTextsApplyResponse> {
  return postJson<UiTextsApplyResponse>('/api/console/ui-texts/apply', payload);
}

export type UiTextsRegenerateResult = {
  language: string;
  filename: string;
  path: string;
  repo_paths: string[];
  key_count: number;
  removed_key_count: number;
  removed_keys: string[];
  empty_key_count: number;
  content: string;
};

export type UiTextsRegenerateResponse = {
  status: string;
  write_enabled: boolean;
  english_key_count: number;
  applied_language_count: number;
  applied_languages: string[];
  results: UiTextsRegenerateResult[];
  repo_dirs: string[];
  persistence_note: string;
};

export function regenerateUiTextsFromEnglish(payload: {
  languages: string[];
}): Promise<UiTextsRegenerateResponse> {
  return postJson<UiTextsRegenerateResponse>('/api/console/ui-texts/regenerate-from-english', payload);
}

export function fetchUiTextsLlmOptions(): Promise<UiTextsLlmOptionsResponse> {
  return getJson<UiTextsLlmOptionsResponse>('/api/console/ui-texts/llm-options');
}

export function generateUiTextsAiSuggestions(payload: {
  model_option_key: string;
  cells: Array<{ key: string; language: string; english_text: string; current_text?: string }>;
}): Promise<UiTextsAiSuggestionsResponse> {
  return postJson<UiTextsAiSuggestionsResponse>('/api/console/ui-texts/ai-suggestions', payload);
}

export type GcsBrowseFolder = {
  prefix: string;
  short_name: string;
};

export type GcsBrowseFile = {
  name: string;
  short_name: string;
  size: number | null;
  size_label: string;
  content_type: string;
  updated: string | null;
  is_audio: boolean;
  is_image: boolean;
};

export type GcsBrowseResponse = {
  status: string;
  bucket: string;
  prefix: string;
  folders: GcsBrowseFolder[];
  files: GcsBrowseFile[];
  next_page_token: string | null;
};

export type GcsSignedUrlResponse = {
  status: string;
  path: string;
  bucket: string;
  signed_url: string;
};

export function browseGcsBucket(params?: {
  prefix?: string;
  page_token?: string;
  max_results?: number;
}): Promise<GcsBrowseResponse> {
  const query = new URLSearchParams();
  if (params?.prefix !== undefined) query.set('prefix', params.prefix);
  if (params?.page_token) query.set('page_token', params.page_token);
  if (params?.max_results) query.set('max_results', String(params.max_results));
  const qs = query.toString();
  return getJson<GcsBrowseResponse>(`/api/console/gcs/browse${qs ? `?${qs}` : ''}`);
}

export function getGcsSignedUrl(path: string): Promise<GcsSignedUrlResponse> {
  return postJson<GcsSignedUrlResponse>('/api/console/gcs/signed-url', { path });
}

export type GcsAudioContextUser = {
  user_id: string;
  email: string | null;
  full_name: string | null;
  role: string | null;
  country_code: string | null;
  language: string | null;
  language_source: string | null;
  current_profile_language: string | null;
};

export type GcsAudioContextResponse = {
  status: 'ok' | 'not_found' | 'error';
  bucket: string;
  blob_name: string;
  match_strategy: string;
  message?: string;
  conversation?: {
    id: string;
    participant_count: number;
  };
  message_record?: {
    id: string | null;
    created_at: string | null;
    type: string | null;
    status: string | null;
    client_message_id: string | null;
    metadata_paths: string[];
  };
  sender?: GcsAudioContextUser;
  recipients?: GcsAudioContextUser[];
  participants?: GcsAudioContextUser[];
  language_summary?: {
    source_language: string | null;
    source_language_source: string | null;
    destination_languages: Array<{ user_id: string; language: string | null; source: string | null }>;
    historical_destination_available: boolean;
  };
};

export function getGcsAudioContext(blobName: string): Promise<GcsAudioContextResponse> {
  return postJson<GcsAudioContextResponse>('/api/console/gcs/audio-context', {
    blob_name: blobName,
  });
}

export type TranscriptData = {
  model_key: string;
  model_display_name: string;
  detected_language: string;
  espeak_backend_language: string | null;
  ipa_supported: boolean;
  transcript: string;
  phonetic_ipa: string | null;
  tone: string | null;
  speaking_rate: string | null;
  speaker_gender: string | null;
  audio_quality: string | null;
  background_noise: string | null;
  speaker_count: number | null;
  confidence: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  estimated_cost_usd: number | null;
};

export type TranscriptResponse = {
  status: string;
  data: TranscriptData;
};

export function requestTranscript(blobName: string, mimeType: string, modelKey: string): Promise<TranscriptResponse> {
  return postJson<TranscriptResponse>('/api/console/gcs/transcribe', {
    blob_name: blobName,
    mime_type: mimeType,
    model_key: modelKey,
  });
}

export type LipTranslationData = {
  model_key: string;
  model_display_name: string;
  fallback_from_model_key?: string | null;
  source_lang: string;
  target_lang: string;
  pivot_text: string | null;
  translated_text: string;
  latency_ms: number;
  persisted: boolean;
};

export type LipTranslationResponse = {
  status: string;
  data: LipTranslationData;
};

export function requestLipTranslation(payload: {
  transcript: string;
  source_lang: string;
  target_lang: string;
  model_key: string;
}): Promise<LipTranslationResponse> {
  return postJson<LipTranslationResponse>('/api/console/gcs/lip-translate', payload);
}

// ─── SVLIP Model Language Preferences (GCS-backed, cross-device) ─────────────

export type ModelPrefs = Record<string, string>;

export type ModelPrefsResponse = {
  status: string;
  prefs: ModelPrefs;
};

export function getModelPrefs(): Promise<ModelPrefsResponse> {
  return getJson<ModelPrefsResponse>('/api/console/svlip/model-prefs');
}

export function setModelPref(language: string, modelKey: string | null): Promise<ModelPrefsResponse> {
  return postJson<ModelPrefsResponse>('/api/console/svlip/model-prefs', {
    language,
    model_key: modelKey ?? '',
    clear: modelKey === null,
  });
}

// ─── SVLIP LIP Translation Config (GCS-backed, shared with Collabra) ────────

export type SvlipLipModelOption = {
  key: string;
  label: string;
  provider?: string;
  model?: string;
  api_key_env?: string;
  source?: string;
};

export type SvlipLipConfig = {
  active_model_key: string;
  available_models: SvlipLipModelOption[];
  default_target_source: string;
  allow_manual_target_override: boolean;
  persist_preview_to_message: boolean;
};

export type SvlipLipConfigResponse = {
  status: string;
  bucket: string;
  path: string;
  config: SvlipLipConfig;
};

export function getSvlipLipConfig(): Promise<SvlipLipConfigResponse> {
  return getJson<SvlipLipConfigResponse>('/api/console/svlip/lip-config');
}

export function setSvlipLipConfig(activeModelKey: string): Promise<SvlipLipConfigResponse> {
  return postJson<SvlipLipConfigResponse>('/api/console/svlip/lip-config', {
    active_model_key: activeModelKey,
    allow_manual_target_override: true,
  });
}

// ─── GCS Audio Upload ────────────────────────────────────────────────────────

export type UploadAudioResponse = {
  status: string;
  path: string;
  filename: string;
  bucket: string;
};

export async function uploadAudioToGcs(
  audio: Blob,
  filename?: string,
  prefix?: string,
): Promise<UploadAudioResponse> {
  const fd = new FormData();
  fd.append('audio', audio, filename ?? 'recording.webm');
  if (filename) fd.append('filename', filename);
  if (prefix) fd.append('prefix', prefix);
  const response = await fetch('/api/console/gcs/upload-audio', {
    method: 'POST',
    credentials: 'include',
    body: fd,
  });
  const data = await response.json() as UploadAudioResponse;
  if (!response.ok) throw new Error((data as { message?: string }).message ?? `upload failed ${response.status}`);
  return data;
}

// ─── Live ASR Streaming ───────────────────────────────────────────────────────

export type LiveChunkResponse = {
  status: string;
  transcript: string;
  language_code: string;
  latency_ms: number;
  duration_ms: number;
  estimated_cost_usd: number;
  estimated_cost_otcoin: number;
  model_key: string;
};

export async function sendLiveChunk(audio: Blob, whisperModel: string): Promise<LiveChunkResponse> {
  const fd = new FormData();
  fd.append('audio', audio, 'chunk.webm');
  fd.append('whisper_model', whisperModel);
  const response = await fetch('/api/console/svlip/live-chunk', {
    method: 'POST',
    credentials: 'include',
    body: fd,
  });
  const data = await response.json() as LiveChunkResponse;
  if (!response.ok) throw new Error((data as { message?: string }).message ?? `live-chunk failed ${response.status}`);
  return data;
}

// ─── Gemini Live Translate ───────────────────────────────────────────────────

export type LiveTranslateLanguage = {
  code: string;
  label: string;
};

export type LiveTranslateConfigResponse = {
  status: string;
  model: string;
  model_resource: string;
  default_target_language_code: string;
  supported_languages: LiveTranslateLanguage[];
  input_audio: { mime_type: string; sample_rate_hz: number; channels: number };
  output_audio: { mime_type: string; sample_rate_hz: number; channels: number };
  runtime_controls?: {
    audio_chunk_ms?: { default: number; min: number; max: number; step: number };
    response_drain_ms?: { default: number; min: number; max: number; step: number };
    silence_duration_ms?: { default: number; min: number; max: number; step: number };
    prefix_padding_ms?: { default: number; min: number; max: number; step: number };
    start_sensitivity?: string[];
    end_sensitivity?: string[];
    activity_handling?: string[];
    turn_coverage?: string[];
    transcription?: string[];
    source_voice_clone_modes?: string[];
    source_voice_clone_execution?: Record<string, string>;
    source_voice_clone_providers?: Record<string, {
      label?: string;
      execution_wired?: boolean;
      credential_configured?: boolean;
      credential_hint?: string;
      profile_configured?: boolean;
      profile_hint?: string;
      required_secret_env?: string | null;
      fallback_to?: string;
      fallback_reason?: string;
      status?: string;
    }>;
    fixed?: Record<string, unknown>;
  };
  save_prefix: string;
  runtime_settings_path?: string;
  auth?: {
    token_strategy: string;
    connect_api_version: string;
    connect_rpc?: string;
    token_query_param?: string;
    client_send_gate?: string;
    setup_shape?: string;
    token_constraint_mode?: string;
    reference_direct_api_version: string;
    api_key_env: string;
    api_key_configured: boolean;
    token_timeout_seconds: number;
    token_expire_seconds: number;
    new_session_expire_seconds: number;
  };
};

export type LiveTranslateSessionTokenResponse = {
  status: string;
  access_token: string;
  model: string;
  model_resource: string;
  target_language_code: string;
  echo_target_language: boolean;
  expires_in_seconds: number;
  new_session_expires_in_seconds?: number;
  expires_at?: string;
  new_session_expires_at?: string;
  latency_ms?: number;
  auth_mode?: string;
  token_constraint_mode?: string;
  setup_shape?: string;
  client_send_gate?: string;
};

export type LiveTranslateClonePreflightResponse = {
  status: string;
  provider: string;
  provider_label?: string;
  provider_mode?: string | null;
  target_language_code?: string;
  ready?: boolean;
  can_execute?: boolean;
  fallback_active?: boolean;
  fallback_to?: string | null;
  fallback_reason?: string | null;
  credential_configured?: boolean;
  execution_wired?: boolean;
  missing?: string[];
  blockers?: string[];
  next_steps?: string[];
  checked_at?: string;
  message?: string;
};

export type LiveTranslateClonePlanResponse = {
  status: string;
  bucket?: string;
  session_id?: string;
  prefix?: string;
  plan?: Record<string, unknown>;
  saved_paths?: string[];
  message?: string;
};

export type LiveTranslateCloneExecuteResponse = {
  status: string;
  bucket?: string;
  session_id?: string;
  prefix?: string;
  result?: Record<string, unknown>;
  saved_paths?: string[];
  message?: string;
};

export type LiveTranslateElevenLabsVoiceProfileResponse = {
  status: string;
  provider?: string;
  speaker_email?: string;
  voice_id?: string;
  requires_verification?: boolean;
  consent_version?: string;
  session_id?: string;
  prefix?: string;
  source_audio_path?: string;
  source_seconds?: number;
  min_source_seconds?: number;
  external_api_called?: boolean;
  missing?: string[];
  blockers?: string[];
  next_steps?: string[];
  fallback_reason?: string;
  provider_http_status?: number;
  provider_error_message?: string;
  provider_error_sample?: string;
  provider_error_code?: string;
  provider_error_type?: string;
  provider_error_status?: string;
  voice_profile_result_path?: string;
  saved_paths?: string[];
  persist_error?: string;
  created_at?: string;
  message?: string;
};

export type LiveTranslateSegmentPayload = {
  text: string;
  language_code: string;
  created_at: string;
};

export type LiveTranslateSaveResponse = {
  status: string;
  bucket: string;
  session_id: string;
  prefix: string;
  saved_paths: string[];
};

export type LiveTranslateRuntimeSettingsResponse = {
  status: string;
  bucket: string;
  path: string;
  created?: boolean;
  requested_profile?: string | null;
  active_profile: string;
  effective_profile: string;
  effective_settings: Record<string, unknown>;
  document: {
    schema_version?: number;
    updated_at?: string | null;
    updated_by?: string | null;
    active_profile?: string;
    fallback_order?: string[];
    runtime_contract?: Record<string, unknown>;
    profiles?: Record<string, Record<string, unknown>>;
    elevenlabs_voice_profiles?: Array<Record<string, unknown>>;
  };
  message?: string;
};

export type LiveTranslateSavedSession = {
  session_id: string;
  prefix: string;
  updated: string | null;
  size: number | null;
};

export type LiveTranslateSessionsResponse = {
  status: string;
  bucket: string;
  sessions: LiveTranslateSavedSession[];
};

export type LiveTranslateSessionDetailResponse = {
  status: string;
  bucket: string;
  session_id: string;
  prefix: string;
  session: Record<string, unknown> | null;
  input_transcript: LiveTranslateSegmentPayload[] | null;
  output_transcript: LiveTranslateSegmentPayload[] | null;
  frontend_log: Array<Record<string, unknown>> | null;
  backend_log: Record<string, unknown> | null;
  clone_plan?: Record<string, unknown> | null;
  clone_result?: Record<string, unknown> | null;
  voice_profile_result?: Record<string, unknown> | null;
  source_audio_url: string | null;
  target_audio_url: string | null;
  target_cloned_audio_url?: string | null;
  source_audio_base64?: string | null;
  target_audio_base64?: string | null;
  target_cloned_audio_base64?: string | null;
  source_audio_mime_type?: string | null;
  target_audio_mime_type?: string | null;
  target_cloned_audio_mime_type?: string | null;
};

export function fetchLiveTranslateConfig(): Promise<LiveTranslateConfigResponse> {
  return getJson<LiveTranslateConfigResponse>('/api/console/live-translate/config');
}

export function fetchLiveTranslateRuntimeSettings(profile?: string): Promise<LiveTranslateRuntimeSettingsResponse> {
  const suffix = profile ? `?profile=${encodeURIComponent(profile)}` : '';
  return getJson<LiveTranslateRuntimeSettingsResponse>(`/api/console/live-translate/runtime-settings${suffix}`);
}

export function saveLiveTranslateRuntimeSettings(payload: {
  profile_key: string;
  active_profile?: string;
  settings: Record<string, unknown>;
  elevenlabs_voice_profiles?: Array<Record<string, unknown>>;
}): Promise<LiveTranslateRuntimeSettingsResponse> {
  return postJson<LiveTranslateRuntimeSettingsResponse>('/api/console/live-translate/runtime-settings', payload);
}

export function createLiveTranslateSessionToken(payload: {
  target_language_code: string;
  echo_target_language: boolean;
}): Promise<LiveTranslateSessionTokenResponse> {
  return postJson<LiveTranslateSessionTokenResponse>('/api/console/live-translate/session-token', payload);
}

export function runLiveTranslateClonePreflight(payload: {
  provider: string;
  provider_mode?: string | null;
  target_language_code?: string;
  voice_alias?: string;
}): Promise<LiveTranslateClonePreflightResponse> {
  return postJson<LiveTranslateClonePreflightResponse>('/api/console/live-translate/source-voice-clone-preflight', payload);
}

export function prepareLiveTranslateClonePlan(payload: {
  session_id: string;
  provider: string;
  provider_mode?: string | null;
  target_language_code?: string;
  voice_alias?: string;
  consent_version?: string;
  save_cloned_audio?: boolean;
  fallback_to_live_translate_audio?: boolean;
}): Promise<LiveTranslateClonePlanResponse> {
  return postJson<LiveTranslateClonePlanResponse>('/api/console/live-translate/source-voice-clone-plan', payload);
}

export function executeLiveTranslateClone(payload: {
  session_id: string;
  provider: string;
  provider_mode?: string | null;
  target_language_code?: string;
  voice_alias?: string;
  consent_version?: string;
  save_cloned_audio?: boolean;
  fallback_to_live_translate_audio?: boolean;
  client_context?: Record<string, unknown>;
}): Promise<LiveTranslateCloneExecuteResponse> {
  return postJson<LiveTranslateCloneExecuteResponse>('/api/console/live-translate/source-voice-clone-execute', payload);
}

export function createElevenLabsVoiceProfile(payload: {
  session_id: string;
  speaker_email: string;
  consent_version: string;
  remove_background_noise?: boolean;
}): Promise<LiveTranslateElevenLabsVoiceProfileResponse> {
  return postJson<LiveTranslateElevenLabsVoiceProfileResponse>('/api/console/live-translate/elevenlabs-voice-profile-create', payload);
}

export function saveLiveTranslateSession(payload: {
  session_id: string;
  target_language_code: string;
  source_language_code?: string;
  echo_target_language: boolean;
  input_transcript: LiveTranslateSegmentPayload[];
  output_transcript: LiveTranslateSegmentPayload[];
  source_audio_wav_base64?: string;
  target_audio_wav_base64?: string;
  metadata?: Record<string, unknown>;
}): Promise<LiveTranslateSaveResponse> {
  return postJson<LiveTranslateSaveResponse>('/api/console/live-translate/save-session', payload);
}

export function fetchLiveTranslateSessions(limit = 10): Promise<LiveTranslateSessionsResponse> {
  return getJson<LiveTranslateSessionsResponse>(`/api/console/live-translate/sessions?limit=${limit}`);
}

export function fetchLiveTranslateSessionDetail(sessionId: string): Promise<LiveTranslateSessionDetailResponse> {
  return getJson<LiveTranslateSessionDetailResponse>(`/api/console/live-translate/session/${encodeURIComponent(sessionId)}`);
}

// ─── Live Conversation guard (kill switch) — Request 69 / doc 1004-0133 ─────

export type LiveConversationGuard = {
  enabled: boolean;
  max_sessions_per_user_per_day?: number | null;
  max_session_seconds?: number | null;
  updated_at?: string | null;
  version?: number | null;
};

export type LiveConversationGuardResponse = {
  status: string;
  message?: string;
  guard?: LiveConversationGuard;
  log?: Array<Record<string, unknown>>;
};

export function fetchLiveConversationGuard(): Promise<LiveConversationGuardResponse> {
  return getJson<LiveConversationGuardResponse>('/api/console/live-translate/live-conversation-guard');
}

export async function updateLiveConversationGuard(enabled: boolean): Promise<LiveConversationGuardResponse> {
  const response = await fetch('/api/console/live-translate/live-conversation-guard', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  const data = await response.json().catch(() => null) as LiveConversationGuardResponse | null;
  if (!response.ok || !data || data.status !== 'ok') {
    throw new Error(data?.message ?? `live-conversation-guard update failed ${response.status}`);
  }
  return data;
}

// --- APK Release Center (درخواست 2082 سند 0016-0201) ---

export type ApkRelease = {
  release_id: string;
  version_name: string;
  version_code: number;
  released_at: string;
  changelog: string;
  file_name: string;
  storage: 'gcs' | 'website_static';
  gcs_object: string | null;
  download_url: string | null;
  size_bytes: number | null;
  sha256: string | null;
  status: 'active' | 'archived';
  uploaded_by?: string | null;
  created_at?: string | null;
};

export type ApkReleasesResponse = {
  status: string;
  message?: string;
  active_release_id: string;
  releases: ApkRelease[];
  release_count: number;
  updated_at: string | null;
  stable_download_url: string;
  version_info_url: string;
  bucket: string;
  base_path: string;
};

export function fetchApkReleases(): Promise<ApkReleasesResponse> {
  return getJson<ApkReleasesResponse>('/api/console/apk-releases');
}

export async function uploadApkRelease(input: {
  file: File;
  versionName: string;
  versionCode: number;
  changelog: string;
}): Promise<ApkReleasesResponse & { release?: ApkRelease }> {
  const formData = new FormData();
  formData.append('file', input.file);
  formData.append('version_name', input.versionName);
  formData.append('version_code', String(input.versionCode));
  formData.append('changelog', input.changelog);
  const response = await fetch('/api/console/apk-releases/upload', {
    method: 'POST',
    credentials: 'include',
    body: formData,
  });
  const data = await response.json().catch(() => null) as (ApkReleasesResponse & { release?: ApkRelease }) | null;
  if (!response.ok || !data || data.status !== 'ok') {
    throw new Error(data?.message ?? `APK upload failed with ${response.status}`);
  }
  return data;
}

export function activateApkRelease(releaseId: string): Promise<ApkReleasesResponse> {
  return postJson<ApkReleasesResponse>('/api/console/apk-releases/activate', { release_id: releaseId });
}

export type ApkReleaseVerifyCheck = {
  name: string;
  ok: boolean;
  detail: string;
};

export type ApkReleaseVerifyResponse = {
  status: string;
  message?: string;
  all_ok: boolean;
  checks: ApkReleaseVerifyCheck[];
  active_release_id: string;
};

export function verifyApkRelease(): Promise<ApkReleaseVerifyResponse> {
  return postJson<ApkReleaseVerifyResponse>('/api/console/apk-releases/verify');
}
