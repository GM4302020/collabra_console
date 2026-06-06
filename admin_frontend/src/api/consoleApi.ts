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
    throw new Error(`${path} failed with ${response.status}`);
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

export function fetchOperationalResources(): Promise<OperationalResourcesResponse> {
  return getJson<OperationalResourcesResponse>('/api/console/operations/resources');
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
  detected_language: string;
  espeak_backend_language: string | null;
  transcript: string;
  phonetic_ipa: string | null;
  tone: string | null;
  speaking_rate: string | null;
  speaker_gender: string | null;
  audio_quality: string | null;
  background_noise: string | null;
  speaker_count: number | null;
  confidence: string | null;
};

export type TranscriptResponse = {
  status: string;
  data: TranscriptData;
};

export function requestTranscript(blobName: string, mimeType: string): Promise<TranscriptResponse> {
  return postJson<TranscriptResponse>('/api/console/gcs/transcribe', {
    blob_name: blobName,
    mime_type: mimeType,
  });
}
