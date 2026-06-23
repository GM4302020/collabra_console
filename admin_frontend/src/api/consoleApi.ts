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
