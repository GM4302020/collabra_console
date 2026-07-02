// FILE: ~/otmega/otmega_app/console/admin_frontend/src/components/live-translate/LiveTranslatePanel.tsx
// ماموریت: تب Live Translate در Routine Tester؛ گفتار زنده، ترجمه گفتاری، ترنسکریپت و ذخیره session.

import { useEffect, useRef, useState } from 'react';
import { Loader2, Mic, Play, RotateCcw, Save, Square, Volume2 } from 'lucide-react';
import {
  fetchConsoleDashboardSettings,
  createLiveTranslateSessionToken,
  fetchLiveTranslateSessionDetail,
  fetchLiveTranslateSessions,
  fetchLiveTranslateConfig,
  LiveTranslateConfigResponse,
  LiveTranslateSaveResponse,
  LiveTranslateSavedSession,
  LiveTranslateSessionDetailResponse,
  LiveTranslateSegmentPayload,
  saveConsoleDashboardSettingsSection,
  saveLiveTranslateSession,
} from '../../api/consoleApi';
import {
  base64ToInt16,
  floatToPcm16,
  INPUT_SAMPLE_RATE,
  int16ToBase64,
  OUTPUT_SAMPLE_RATE,
  pcm16ChunksToWavBase64,
  playPcm16Chunk,
  resampleFloat32,
} from './liveTranslateAudio';

type StreamStatus = 'idle' | 'connecting' | 'recording' | 'live' | 'draining' | 'stopped' | 'saving';

type Segment = {
  id: number;
  text: string;
  language_code: string;
  created_at: string;
};

type StartSensitivity = 'START_SENSITIVITY_HIGH' | 'START_SENSITIVITY_LOW';
type EndSensitivity = 'END_SENSITIVITY_HIGH' | 'END_SENSITIVITY_LOW';
type ActivityHandling = 'START_OF_ACTIVITY_INTERRUPTS' | 'NO_INTERRUPTION';
type TurnCoverage = 'TURN_INCLUDES_ONLY_ACTIVITY' | 'TURN_INCLUDES_ALL_INPUT';

type LiveMessage = {
  setupComplete?: Record<string, never>;
  usageMetadata?: Record<string, unknown>;
  serverContent?: {
    inputTranscription?: { text?: string; languageCode?: string };
    outputTranscription?: { text?: string; languageCode?: string };
    modelTurn?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }> };
  };
  goAway?: { timeLeft?: string };
  error?: { message?: string; code?: number; status?: string };
};

type MonitorState = {
  token: string;
  websocket: string;
  setup: string;
  mic: string;
  chunksCaptured: number;
  chunksSent: number;
  queuedChunks: number;
  sourceSeconds: number;
  sourceBytes: number;
  level: number;
  peak: number;
  targetChunks: number;
  targetSeconds: number;
  serverMessages: number;
  lastEvent: string;
  usage: string;
};

type WaitIndicator = {
  label: string;
  detail?: string;
  tone: 'info' | 'warning' | 'danger';
  startedAt: number;
  endsAt?: number;
};

type SettingsProfileKey = 'general' | 'ios' | 'android' | 'windows' | 'macos' | 'linux' | 'other';

type RuntimeSettingsSnapshot = typeof DEFAULT_RUNTIME_SETTINGS & {
  savedAt?: string;
  profileKey?: SettingsProfileKey;
  profileLabel?: string;
};

type PersistedWorkspaceState = {
  last_session_id?: string | null;
  active_settings_profile?: SettingsProfileKey;
  runtime_settings?: RuntimeSettingsSnapshot;
  updated_at?: string;
};

const WS_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained';
const DASHBOARD_SETTINGS_SECTION = 'live_translate';
const DEFAULT_AUDIO_CHUNK_MS = 250;
const MAX_QUEUED_AUDIO_CHUNKS = 600;
const STOP_SETUP_WAIT_MS = 8000;
const SETUP_COMPLETE_LOG_MS = 8000;
const TOKEN_REQUEST_WAIT_MS = 25000;
const DEFAULT_TARGET_LANG = 'en';
const START_SENSITIVITY_OPTIONS: StartSensitivity[] = ['START_SENSITIVITY_HIGH', 'START_SENSITIVITY_LOW'];
const END_SENSITIVITY_OPTIONS: EndSensitivity[] = ['END_SENSITIVITY_HIGH', 'END_SENSITIVITY_LOW'];
const ACTIVITY_HANDLING_OPTIONS: ActivityHandling[] = ['START_OF_ACTIVITY_INTERRUPTS', 'NO_INTERRUPTION'];
const TURN_COVERAGE_OPTIONS: TurnCoverage[] = ['TURN_INCLUDES_ONLY_ACTIVITY', 'TURN_INCLUDES_ALL_INPUT'];
const DEFAULT_RUNTIME_SETTINGS = {
  targetLang: DEFAULT_TARGET_LANG,
  echoTarget: false,
  inputTranscriptEnabled: true,
  outputTranscriptEnabled: true,
  audioChunkMs: DEFAULT_AUDIO_CHUNK_MS,
  responseDrainMs: 6000,
  silenceDurationMs: 900,
  prefixPaddingMs: 250,
  startSensitivity: 'START_SENSITIVITY_HIGH' as StartSensitivity,
  endSensitivity: 'END_SENSITIVITY_LOW' as EndSensitivity,
  activityHandling: 'START_OF_ACTIVITY_INTERRUPTS' as ActivityHandling,
  turnCoverage: 'TURN_INCLUDES_ONLY_ACTIVITY' as TurnCoverage,
};
const LIVE_TRANSLATE_PRICING = {
  inputPerMillionTokensUsd: 3.5,
  outputPerMillionTokensUsd: 21,
  inputPerMinuteUsd: 0.0053,
  outputPerMinuteUsd: 0.0315,
  sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
};
const SETTINGS_PROFILES: Array<{ key: SettingsProfileKey; label: string }> = [
  { key: 'general', label: 'General' },
  { key: 'ios', label: 'iOS' },
  { key: 'android', label: 'Android' },
  { key: 'windows', label: 'Windows' },
  { key: 'macos', label: 'macOS' },
  { key: 'linux', label: 'Linux' },
  { key: 'other', label: 'Other OS' },
];
const SETTINGS_PROFILE_KEYS = SETTINGS_PROFILES.map((item) => item.key);
const LANGUAGE_DISPLAY_LABELS: Record<string, string> = {
  ar: 'Arabic',
  de: 'German',
  el: 'Greek',
  es: 'Spanish',
  fa: 'Persian',
  fr: 'French',
  hi: 'Hindi',
  it: 'Italian',
  ja: 'Japanese',
  ko: 'Korean',
  pl: 'Polish',
  ru: 'Russian',
  tr: 'Turkish',
  ur: 'Urdu',
};

function defaultMonitor(): MonitorState {
  return {
    token: 'idle',
    websocket: 'idle',
    setup: 'pending',
    mic: 'idle',
    chunksCaptured: 0,
    chunksSent: 0,
    queuedChunks: 0,
    sourceSeconds: 0,
    sourceBytes: 0,
    level: 0,
    peak: 0,
    targetChunks: 0,
    targetSeconds: 0,
    serverMessages: 0,
    lastEvent: 'idle',
    usage: '',
  };
}

function nowId() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 17);
  return `lt-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

function compactText(value?: string) {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function toPayload(segments: Segment[]): LiveTranslateSegmentPayload[] {
  return segments.map((segment) => ({
    text: segment.text,
    language_code: segment.language_code,
    created_at: segment.created_at,
  }));
}

function summarizeLiveMessage(message: LiveMessage) {
  const content = message.serverContent;
  const parts = content?.modelTurn?.parts || [];
  return {
    keys: Object.keys(message),
    server_content_keys: content ? Object.keys(content) : [],
    has_input_transcription: Boolean(content?.inputTranscription?.text),
    has_output_transcription: Boolean(content?.outputTranscription?.text),
    model_turn_parts: parts.length,
    audio_parts: parts.filter((part) => Boolean(part.inlineData?.mimeType?.startsWith('audio/'))).length,
    has_usage_metadata: Boolean(message.usageMetadata),
    has_go_away: Boolean(message.goAway),
    has_error: Boolean(message.error),
  };
}

function summarizeRawPayload(raw: string) {
  return {
    chars: raw.length,
    sample: raw.slice(0, 1200),
  };
}

function readNumberSetting(key: string, fallback: number, min: number, max: number) {
  const raw = window.localStorage.getItem(key);
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function readBooleanSetting(key: string, fallback: boolean) {
  const raw = window.localStorage.getItem(key);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return fallback;
}

function readStringSetting(key: string, fallback: string) {
  const raw = window.localStorage.getItem(key);
  return raw && raw.trim() ? raw.trim() : fallback;
}

function readOptionSetting<T extends string>(key: string, fallback: T, options: readonly T[]) {
  const raw = window.localStorage.getItem(key) as T | null;
  return raw && options.includes(raw) ? raw : fallback;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number) {
  const next = Number(value);
  if (!Number.isFinite(next)) return fallback;
  return Math.min(max, Math.max(min, next));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function detailTokenCount(details: unknown, modality: string) {
  if (!Array.isArray(details)) return 0;
  return details.reduce((sum, item) => {
    if (!isRecord(item) || String(item.modality || '').toUpperCase() !== modality) return sum;
    return sum + clampNumber(item.tokenCount, 0, 0, Number.MAX_SAFE_INTEGER);
  }, 0);
}

function formatUsd(value: number) {
  if (!Number.isFinite(value)) return '$0.000000';
  if (value >= 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(6)}`;
}

function estimateSessionCost(usage: string, sourceSeconds: number, targetSeconds: number) {
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = usage ? JSON.parse(usage) as Record<string, unknown> : null;
  } catch {
    parsed = null;
  }
  const inputAudioTokens = parsed
    ? detailTokenCount(parsed.promptTokensDetails, 'AUDIO') || clampNumber(parsed.promptTokenCount, 0, 0, Number.MAX_SAFE_INTEGER)
    : 0;
  const outputAudioTokens = parsed
    ? detailTokenCount(parsed.responseTokensDetails, 'AUDIO') || clampNumber(parsed.responseTokenCount, 0, 0, Number.MAX_SAFE_INTEGER)
    : 0;
  const totalTokens = parsed ? clampNumber(parsed.totalTokenCount, inputAudioTokens + outputAudioTokens, 0, Number.MAX_SAFE_INTEGER) : 0;
  const tokenCost =
    (inputAudioTokens / 1_000_000) * LIVE_TRANSLATE_PRICING.inputPerMillionTokensUsd
    + (outputAudioTokens / 1_000_000) * LIVE_TRANSLATE_PRICING.outputPerMillionTokensUsd;
  const minuteCost =
    (sourceSeconds / 60) * LIVE_TRANSLATE_PRICING.inputPerMinuteUsd
    + (targetSeconds / 60) * LIVE_TRANSLATE_PRICING.outputPerMinuteUsd;
  return { inputAudioTokens, outputAudioTokens, totalTokens, tokenCost, minuteCost, hasUsage: Boolean(parsed) };
}

function usageStringFromUnknown(value: unknown) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function profileStorageKey(profileKey: SettingsProfileKey) {
  return `lt_settings_profile_${profileKey}`;
}

function profileLabel(profileKey: SettingsProfileKey) {
  return SETTINGS_PROFILES.find((item) => item.key === profileKey)?.label || profileKey;
}

function languageDisplayLabel(language: LiveTranslateConfigResponse['supported_languages'][number]) {
  return LANGUAGE_DISPLAY_LABELS[language.code] || language.label;
}

function languageSearchText(language: LiveTranslateConfigResponse['supported_languages'][number]) {
  return `${language.code} ${language.label} ${languageDisplayLabel(language)}`.toLowerCase();
}

function audioDataUrl(base64?: string | null, mimeType?: string | null) {
  return base64 ? `data:${mimeType || 'audio/wav'};base64,${base64}` : null;
}

function readStoredSettingsProfile(profileKey: SettingsProfileKey): RuntimeSettingsSnapshot | null {
  const raw = window.localStorage.getItem(profileStorageKey(profileKey));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      targetLang: typeof parsed.targetLang === 'string' ? parsed.targetLang : DEFAULT_RUNTIME_SETTINGS.targetLang,
      echoTarget: typeof parsed.echoTarget === 'boolean' ? parsed.echoTarget : DEFAULT_RUNTIME_SETTINGS.echoTarget,
      inputTranscriptEnabled: typeof parsed.inputTranscriptEnabled === 'boolean' ? parsed.inputTranscriptEnabled : DEFAULT_RUNTIME_SETTINGS.inputTranscriptEnabled,
      outputTranscriptEnabled: typeof parsed.outputTranscriptEnabled === 'boolean' ? parsed.outputTranscriptEnabled : DEFAULT_RUNTIME_SETTINGS.outputTranscriptEnabled,
      audioChunkMs: clampNumber(parsed.audioChunkMs, DEFAULT_RUNTIME_SETTINGS.audioChunkMs, 100, 500),
      responseDrainMs: clampNumber(parsed.responseDrainMs, DEFAULT_RUNTIME_SETTINGS.responseDrainMs, 3000, 12000),
      silenceDurationMs: clampNumber(parsed.silenceDurationMs, DEFAULT_RUNTIME_SETTINGS.silenceDurationMs, 300, 2000),
      prefixPaddingMs: clampNumber(parsed.prefixPaddingMs, DEFAULT_RUNTIME_SETTINGS.prefixPaddingMs, 0, 1000),
      startSensitivity: START_SENSITIVITY_OPTIONS.includes(parsed.startSensitivity as StartSensitivity) ? parsed.startSensitivity as StartSensitivity : DEFAULT_RUNTIME_SETTINGS.startSensitivity,
      endSensitivity: END_SENSITIVITY_OPTIONS.includes(parsed.endSensitivity as EndSensitivity) ? parsed.endSensitivity as EndSensitivity : DEFAULT_RUNTIME_SETTINGS.endSensitivity,
      activityHandling: ACTIVITY_HANDLING_OPTIONS.includes(parsed.activityHandling as ActivityHandling) ? parsed.activityHandling as ActivityHandling : DEFAULT_RUNTIME_SETTINGS.activityHandling,
      turnCoverage: TURN_COVERAGE_OPTIONS.includes(parsed.turnCoverage as TurnCoverage) ? parsed.turnCoverage as TurnCoverage : DEFAULT_RUNTIME_SETTINGS.turnCoverage,
      savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : undefined,
      profileKey,
      profileLabel: profileLabel(profileKey),
    };
  } catch {
    return null;
  }
}

export default function LiveTranslatePanel() {
  const [config, setConfig] = useState<LiveTranslateConfigResponse | null>(null);
  const [targetLang, setTargetLang] = useState(() => readStringSetting('lt_target_lang', DEFAULT_RUNTIME_SETTINGS.targetLang));
  const [languageSearch, setLanguageSearch] = useState('');
  const [echoTarget, setEchoTarget] = useState(() => readBooleanSetting('lt_echo_target', DEFAULT_RUNTIME_SETTINGS.echoTarget));
  const [inputTranscriptEnabled, setInputTranscriptEnabled] = useState(() => readBooleanSetting('lt_input_transcript', DEFAULT_RUNTIME_SETTINGS.inputTranscriptEnabled));
  const [outputTranscriptEnabled, setOutputTranscriptEnabled] = useState(() => readBooleanSetting('lt_output_transcript', DEFAULT_RUNTIME_SETTINGS.outputTranscriptEnabled));
  const [audioChunkMs, setAudioChunkMs] = useState(() => readNumberSetting('lt_audio_chunk_ms', DEFAULT_RUNTIME_SETTINGS.audioChunkMs, 100, 500));
  const [responseDrainMs, setResponseDrainMs] = useState(() => readNumberSetting('lt_response_drain_ms', DEFAULT_RUNTIME_SETTINGS.responseDrainMs, 3000, 12000));
  const [silenceDurationMs, setSilenceDurationMs] = useState(() => readNumberSetting('lt_silence_duration_ms', DEFAULT_RUNTIME_SETTINGS.silenceDurationMs, 300, 2000));
  const [prefixPaddingMs, setPrefixPaddingMs] = useState(() => readNumberSetting('lt_prefix_padding_ms', DEFAULT_RUNTIME_SETTINGS.prefixPaddingMs, 0, 1000));
  const [startSensitivity, setStartSensitivity] = useState<StartSensitivity>(() => readOptionSetting('lt_start_sensitivity', DEFAULT_RUNTIME_SETTINGS.startSensitivity, START_SENSITIVITY_OPTIONS));
  const [endSensitivity, setEndSensitivity] = useState<EndSensitivity>(() => readOptionSetting('lt_end_sensitivity', DEFAULT_RUNTIME_SETTINGS.endSensitivity, END_SENSITIVITY_OPTIONS));
  const [activityHandling, setActivityHandling] = useState<ActivityHandling>(() => readOptionSetting('lt_activity_handling', DEFAULT_RUNTIME_SETTINGS.activityHandling, ACTIVITY_HANDLING_OPTIONS));
  const [turnCoverage, setTurnCoverage] = useState<TurnCoverage>(() => readOptionSetting('lt_turn_coverage', DEFAULT_RUNTIME_SETTINGS.turnCoverage, TURN_COVERAGE_OPTIONS));
  const [activeSettingsProfile, setActiveSettingsProfile] = useState<SettingsProfileKey>(() => readOptionSetting('lt_active_settings_profile', 'general', SETTINGS_PROFILE_KEYS));
  const [lastProfileNotice, setLastProfileNotice] = useState('');
  const [status, setStatus] = useState<StreamStatus>('idle');
  const [inputSegments, setInputSegments] = useState<Segment[]>([]);
  const [outputSegments, setOutputSegments] = useState<Segment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<LiveTranslateSaveResponse | null>(null);
  const [savedSessions, setSavedSessions] = useState<LiveTranslateSavedSession[]>([]);
  const [sessionDetail, setSessionDetail] = useState<LiveTranslateSessionDetailResponse | null>(null);
  const [sessionBrowserStatus, setSessionBrowserStatus] = useState('idle');
  const [lastSessionId, setLastSessionId] = useState<string | null>(() => readStringSetting('lt_last_session_id', '') || null);
  const [monitor, setMonitor] = useState<MonitorState>(() => defaultMonitor());
  const [waitIndicator, setWaitIndicator] = useState<WaitIndicator | null>(null);
  const [clockMs, setClockMs] = useState(() => Date.now());

  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const outputAudioCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const zeroGainRef = useRef<GainNode | null>(null);
  const playCursorRef = useRef(0);
  const sessionIdRef = useRef(nowId());
  const segmentIdRef = useRef(0);
  const inputSegmentsRef = useRef<Segment[]>([]);
  const outputSegmentsRef = useRef<Segment[]>([]);
  const sourcePcmChunksRef = useRef<Int16Array[]>([]);
  const targetPcmChunksRef = useRef<Int16Array[]>([]);
  const queuedPcmChunksRef = useRef<Int16Array[]>([]);
  const setupSentRef = useRef(false);
  const setupCompleteRef = useRef(false);
  const setupCompleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPcmRef = useRef<Int16Array>(new Int16Array(0));
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const localCaptureActiveRef = useRef(false);
  const stopRequestedRef = useRef(false);
  const serverMessageCountRef = useRef(0);
  const sentAudioLogCountRef = useRef(0);
  const audioChunkMsRef = useRef(audioChunkMs);
  const responseDrainMsRef = useRef(responseDrainMs);
  const eventLogRef = useRef<Array<Record<string, unknown>>>([]);
  const dashboardSettingsLoadedRef = useRef(false);
  const dashboardSettingsSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function recordEvent(event: string, details?: Record<string, unknown>) {
    eventLogRef.current.push({
      at: new Date().toISOString(),
      event,
      ...(details ? { details } : {}),
    });
    if (eventLogRef.current.length > 500) eventLogRef.current.shift();
  }

  function beginWait(label: string, durationMs?: number, detail?: string, tone: WaitIndicator['tone'] = 'warning') {
    const startedAt = Date.now();
    setClockMs(startedAt);
    setWaitIndicator({
      label,
      detail,
      tone,
      startedAt,
      ...(durationMs ? { endsAt: startedAt + durationMs } : {}),
    });
  }

  function clearWait() {
    setWaitIndicator(null);
  }

  function applyRuntimeSettings(settings: Record<string, unknown>, options?: { persistTarget?: boolean }) {
    if (typeof settings.targetLang === 'string' && options?.persistTarget !== false) setTargetLang(settings.targetLang);
    if (typeof settings.echoTarget === 'boolean') setEchoTarget(settings.echoTarget);
    if (typeof settings.inputTranscriptEnabled === 'boolean') setInputTranscriptEnabled(settings.inputTranscriptEnabled);
    if (typeof settings.outputTranscriptEnabled === 'boolean') setOutputTranscriptEnabled(settings.outputTranscriptEnabled);
    setAudioChunkMs(clampNumber(settings.audioChunkMs, DEFAULT_RUNTIME_SETTINGS.audioChunkMs, 100, 500));
    setResponseDrainMs(clampNumber(settings.responseDrainMs, DEFAULT_RUNTIME_SETTINGS.responseDrainMs, 3000, 12000));
    setSilenceDurationMs(clampNumber(settings.silenceDurationMs, DEFAULT_RUNTIME_SETTINGS.silenceDurationMs, 300, 2000));
    setPrefixPaddingMs(clampNumber(settings.prefixPaddingMs, DEFAULT_RUNTIME_SETTINGS.prefixPaddingMs, 0, 1000));
    if (START_SENSITIVITY_OPTIONS.includes(settings.startSensitivity as StartSensitivity)) setStartSensitivity(settings.startSensitivity as StartSensitivity);
    if (END_SENSITIVITY_OPTIONS.includes(settings.endSensitivity as EndSensitivity)) setEndSensitivity(settings.endSensitivity as EndSensitivity);
    if (ACTIVITY_HANDLING_OPTIONS.includes(settings.activityHandling as ActivityHandling)) setActivityHandling(settings.activityHandling as ActivityHandling);
    if (TURN_COVERAGE_OPTIONS.includes(settings.turnCoverage as TurnCoverage)) setTurnCoverage(settings.turnCoverage as TurnCoverage);
  }

  function currentRuntimeSettings(profileKey = activeSettingsProfile): RuntimeSettingsSnapshot {
    return {
      targetLang,
      echoTarget,
      inputTranscriptEnabled,
      outputTranscriptEnabled,
      audioChunkMs,
      responseDrainMs,
      silenceDurationMs,
      prefixPaddingMs,
      startSensitivity,
      endSensitivity,
      activityHandling,
      turnCoverage,
      savedAt: new Date().toISOString(),
      profileKey,
      profileLabel: profileLabel(profileKey),
    };
  }

  function saveSettingsProfile(profileKey: SettingsProfileKey) {
    const snapshot = currentRuntimeSettings(profileKey);
    window.localStorage.setItem(profileStorageKey(profileKey), JSON.stringify(snapshot));
    setActiveSettingsProfile(profileKey);
    setLastProfileNotice(`Saved ${snapshot.profileLabel} settings`);
    recordEvent('settings.profile_saved', {
      profile_key: profileKey,
      profile_label: snapshot.profileLabel,
      saved_at: snapshot.savedAt,
    });
  }

  function loadSettingsProfile(profileKey: SettingsProfileKey) {
    const snapshot = readStoredSettingsProfile(profileKey);
    if (!snapshot) {
      setLastProfileNotice(`${profileLabel(profileKey)} settings not saved yet`);
      recordEvent('settings.profile_missing', { profile_key: profileKey, profile_label: profileLabel(profileKey) });
      return;
    }
    applyRuntimeSettings(snapshot);
    setActiveSettingsProfile(profileKey);
    setLastProfileNotice(`Loaded ${snapshot.profileLabel} settings`);
    recordEvent('settings.profile_loaded', {
      profile_key: profileKey,
      profile_label: snapshot.profileLabel,
      saved_at: snapshot.savedAt,
    });
  }

  function restoreDefaultSettings() {
    applyRuntimeSettings(DEFAULT_RUNTIME_SETTINGS);
    setActiveSettingsProfile('general');
    setLastProfileNotice('Loaded default runtime settings');
    recordEvent('settings.defaults_loaded', DEFAULT_RUNTIME_SETTINGS);
  }

  async function loadPersistedWorkspaceState() {
    try {
      const response = await fetchConsoleDashboardSettings();
      const section = response.settings[DASHBOARD_SETTINGS_SECTION];
      if (!isRecord(section)) return lastSessionId;
      const runtimeSettings = isRecord(section.runtime_settings) ? section.runtime_settings : {};
      if (Object.keys(runtimeSettings).length) applyRuntimeSettings(runtimeSettings);
      const profileKey = String(section.active_settings_profile || runtimeSettings.profileKey || '');
      if (SETTINGS_PROFILE_KEYS.includes(profileKey as SettingsProfileKey)) {
        setActiveSettingsProfile(profileKey as SettingsProfileKey);
      }
      const savedSessionId = typeof section.last_session_id === 'string' && section.last_session_id.trim()
        ? section.last_session_id.trim()
        : lastSessionId;
      if (savedSessionId) setLastSessionId(savedSessionId);
      recordEvent('settings.dashboard_loaded', {
        section: DASHBOARD_SETTINGS_SECTION,
        last_session_id: savedSessionId || null,
        has_runtime_settings: Object.keys(runtimeSettings).length > 0,
      });
      return savedSessionId || null;
    } catch (exc) {
      recordEvent('settings.dashboard_load_failed', { message: exc instanceof Error ? exc.message : String(exc) });
      return lastSessionId;
    } finally {
      dashboardSettingsLoadedRef.current = true;
    }
  }

  function persistWorkspaceState() {
    const nextSessionId = lastSessionId || saved?.session_id || null;
    window.localStorage.setItem('lt_last_session_id', nextSessionId || '');
    const payload: PersistedWorkspaceState = {
      last_session_id: nextSessionId,
      active_settings_profile: activeSettingsProfile,
      runtime_settings: currentRuntimeSettings(activeSettingsProfile),
      updated_at: new Date().toISOString(),
    };
    saveConsoleDashboardSettingsSection(DASHBOARD_SETTINGS_SECTION, payload as Record<string, unknown>)
      .then(() => recordEvent('settings.dashboard_saved', { last_session_id: nextSessionId }))
      .catch((exc) => recordEvent('settings.dashboard_save_failed', { message: exc instanceof Error ? exc.message : String(exc) }));
  }

  useEffect(() => {
    let ignore = false;
    async function init() {
      let preferredSessionId: string | null = lastSessionId;
      try {
        const payload = await fetchLiveTranslateConfig();
        if (ignore) return;
        setConfig(payload);
        setTargetLang((current) => (
          payload.supported_languages.some((lang) => lang.code.toLowerCase() === current.toLowerCase())
            ? current
            : payload.default_target_language_code || DEFAULT_TARGET_LANG
        ));
        recordEvent('config.loaded', { model: payload.model, auth: payload.auth });
      } catch (exc) {
        if (!ignore) setError(exc instanceof Error ? exc.message : 'Live Translate config failed.');
      }
      if (ignore) return;
      preferredSessionId = await loadPersistedWorkspaceState();
      if (ignore) return;
      await loadSavedSessions(preferredSessionId || undefined, { autoSelectLatest: !preferredSessionId });
    }
    void init();
    return () => { ignore = true; cleanup(); };
  }, []);

  useEffect(() => {
    if (!waitIndicator) return undefined;
    const timer = window.setInterval(() => setClockMs(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [waitIndicator]);

  useEffect(() => {
    audioChunkMsRef.current = audioChunkMs;
    window.localStorage.setItem('lt_audio_chunk_ms', String(audioChunkMs));
  }, [audioChunkMs]);

  useEffect(() => {
    responseDrainMsRef.current = responseDrainMs;
    window.localStorage.setItem('lt_response_drain_ms', String(responseDrainMs));
  }, [responseDrainMs]);

  useEffect(() => { window.localStorage.setItem('lt_input_transcript', String(inputTranscriptEnabled)); }, [inputTranscriptEnabled]);
  useEffect(() => { window.localStorage.setItem('lt_output_transcript', String(outputTranscriptEnabled)); }, [outputTranscriptEnabled]);
  useEffect(() => { window.localStorage.setItem('lt_target_lang', targetLang); }, [targetLang]);
  useEffect(() => { window.localStorage.setItem('lt_echo_target', String(echoTarget)); }, [echoTarget]);
  useEffect(() => { window.localStorage.setItem('lt_active_settings_profile', activeSettingsProfile); }, [activeSettingsProfile]);
  useEffect(() => { window.localStorage.setItem('lt_silence_duration_ms', String(silenceDurationMs)); }, [silenceDurationMs]);
  useEffect(() => { window.localStorage.setItem('lt_prefix_padding_ms', String(prefixPaddingMs)); }, [prefixPaddingMs]);
  useEffect(() => { window.localStorage.setItem('lt_start_sensitivity', startSensitivity); }, [startSensitivity]);
  useEffect(() => { window.localStorage.setItem('lt_end_sensitivity', endSensitivity); }, [endSensitivity]);
  useEffect(() => { window.localStorage.setItem('lt_activity_handling', activityHandling); }, [activityHandling]);
  useEffect(() => { window.localStorage.setItem('lt_turn_coverage', turnCoverage); }, [turnCoverage]);

  useEffect(() => {
    window.localStorage.setItem('lt_last_session_id', lastSessionId || '');
    if (!dashboardSettingsLoadedRef.current) return undefined;
    if (status !== 'idle' && status !== 'stopped') return undefined;
    if (dashboardSettingsSaveTimerRef.current) window.clearTimeout(dashboardSettingsSaveTimerRef.current);
    dashboardSettingsSaveTimerRef.current = window.setTimeout(() => {
      persistWorkspaceState();
      dashboardSettingsSaveTimerRef.current = null;
    }, 800);
    return () => {
      if (dashboardSettingsSaveTimerRef.current) window.clearTimeout(dashboardSettingsSaveTimerRef.current);
      dashboardSettingsSaveTimerRef.current = null;
    };
  }, [
    activeSettingsProfile,
    audioChunkMs,
    echoTarget,
    endSensitivity,
    inputTranscriptEnabled,
    lastSessionId,
    outputTranscriptEnabled,
    prefixPaddingMs,
    responseDrainMs,
    silenceDurationMs,
    startSensitivity,
    status,
    targetLang,
    turnCoverage,
    activityHandling,
  ]);

  function syncInput(next: Segment[]) {
    inputSegmentsRef.current = next;
    setInputSegments([...next]);
  }

  function syncOutput(next: Segment[]) {
    outputSegmentsRef.current = next;
    setOutputSegments([...next]);
  }

  function appendSegment(kind: 'input' | 'output', text: string, languageCode?: string) {
    const clean = compactText(text);
    if (!clean) return;
    segmentIdRef.current += 1;
    const next: Segment = {
      id: segmentIdRef.current,
      text: clean,
      language_code: (languageCode || (kind === 'output' ? targetLang : 'auto')).toLowerCase(),
      created_at: new Date().toISOString(),
    };
    if (kind === 'input') syncInput([...inputSegmentsRef.current, next]);
    else syncOutput([...outputSegmentsRef.current, next]);
  }

  function cleanup() {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
    if (setupCompleteTimerRef.current) clearTimeout(setupCompleteTimerRef.current);
    setupCompleteTimerRef.current = null;
    processorRef.current?.disconnect();
    sourceRef.current?.disconnect();
    zeroGainRef.current?.disconnect();
    processorRef.current = null;
    sourceRef.current = null;
    zeroGainRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    localCaptureActiveRef.current = false;
    if (wsRef.current && wsRef.current.readyState <= WebSocket.OPEN) wsRef.current.close();
    wsRef.current = null;
    setupSentRef.current = false;
    setupCompleteRef.current = false;
    serverMessageCountRef.current = 0;
    sentAudioLogCountRef.current = 0;
    clearWait();
    pendingPcmRef.current = new Int16Array(0);
    queuedPcmChunksRef.current = [];
    stopRequestedRef.current = false;
    void inputAudioCtxRef.current?.close();
    inputAudioCtxRef.current = null;
  }

  function resetSession() {
    cleanup();
    sessionIdRef.current = nowId();
    segmentIdRef.current = 0;
    sourcePcmChunksRef.current = [];
    targetPcmChunksRef.current = [];
    playCursorRef.current = 0;
    syncInput([]);
    syncOutput([]);
    setSaved(null);
    setSessionDetail(null);
    setError(null);
    setMonitor(defaultMonitor());
    setStatus('idle');
  }

  function prepareFreshRecordingSession() {
    sessionIdRef.current = nowId();
    segmentIdRef.current = 0;
    sourcePcmChunksRef.current = [];
    targetPcmChunksRef.current = [];
    queuedPcmChunksRef.current = [];
    pendingPcmRef.current = new Int16Array(0);
    playCursorRef.current = 0;
    syncInput([]);
    syncOutput([]);
    setSaved(null);
    setSessionDetail(null);
    setError(null);
    setMonitor(defaultMonitor());
  }

  async function startStream() {
    if (status === 'live' || status === 'connecting' || status === 'recording') return;
    prepareFreshRecordingSession();
    setError(null);
    eventLogRef.current = [];
    const runtimeSettings = {
      targetLang,
      echoTarget,
      inputTranscriptEnabled,
      outputTranscriptEnabled,
      audioChunkMs,
      responseDrainMs,
      silenceDurationMs,
      prefixPaddingMs,
      startSensitivity,
      endSensitivity,
      activityHandling,
      turnCoverage,
    };
    recordEvent('stream.start_clicked', runtimeSettings);
    beginWait('Requesting token', TOKEN_REQUEST_WAIT_MS, 'Waiting for Gemini ephemeral token.', 'warning');
    setupSentRef.current = false;
    setupCompleteRef.current = false;
    pendingPcmRef.current = new Int16Array(0);
    queuedPcmChunksRef.current = [];
    stopRequestedRef.current = false;
    serverMessageCountRef.current = 0;
    sentAudioLogCountRef.current = 0;
    setMonitor((prev) => ({ ...prev, token: 'requesting', websocket: 'idle', setup: 'pending', lastEvent: 'requesting token' }));
    setStatus('connecting');
    try {
      const tokenPromise = withTimeout(createLiveTranslateSessionToken({
        target_language_code: targetLang,
        echo_target_language: echoTarget,
      }), TOKEN_REQUEST_WAIT_MS, 'Live Translate token request timed out.');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      streamRef.current = stream;
      localCaptureActiveRef.current = true;
      setStatus('recording');
      recordEvent('microphone.active', { track_count: stream.getTracks().length });
      setMonitor((prev) => ({ ...prev, mic: 'active', lastEvent: 'microphone active' }));
      const inputCtx = new AudioContext();
      inputAudioCtxRef.current = inputCtx;
      const outputCtx = outputAudioCtxRef.current || new AudioContext();
      outputAudioCtxRef.current = outputCtx;
      if (outputCtx.state === 'suspended') await outputCtx.resume();

      setupLocalAudioPipeline(stream, inputCtx);
      const tokenPayload = await tokenPromise;
      recordEvent('token.issued', { latency_ms: tokenPayload.latency_ms, auth_mode: tokenPayload.auth_mode });
      beginWait('Opening stream', SETUP_COMPLETE_LOG_MS, 'Waiting for WebSocket setup and model readiness.', 'warning');
      setMonitor((prev) => ({
        ...prev,
        token: 'issued',
        lastEvent: `token issued · ${tokenPayload.latency_ms ?? '?'}ms · session window ${tokenPayload.new_session_expires_in_seconds ?? '?'}s`,
      }));
      const ws = new WebSocket(`${WS_URL}?access_token=${encodeURIComponent(tokenPayload.access_token)}`);
      wsRef.current = ws;
      ws.onopen = () => {
        recordEvent('websocket.open', { endpoint: 'BidiGenerateContentConstrained', token_query_param: 'access_token' });
        setMonitor((prev) => ({ ...prev, websocket: 'open', lastEvent: 'websocket open' }));
        beginWait('Waiting for setup', SETUP_COMPLETE_LOG_MS, 'Audio stays queued until setup is complete.', 'warning');
        const setupPayload: {
          setup: {
            model: string;
            inputAudioTranscription?: Record<string, never>;
            outputAudioTranscription?: Record<string, never>;
            generationConfig: {
              responseModalities: string[];
              translationConfig: { targetLanguageCode: string; echoTargetLanguage: boolean };
            };
            realtimeInputConfig: {
              automaticActivityDetection: {
                disabled: boolean;
                startOfSpeechSensitivity: StartSensitivity;
                endOfSpeechSensitivity: EndSensitivity;
                prefixPaddingMs: number;
                silenceDurationMs: number;
              };
              activityHandling: ActivityHandling;
              turnCoverage: TurnCoverage;
            };
          };
        } = {
          setup: {
            model: tokenPayload.model_resource,
            generationConfig: {
              responseModalities: ['AUDIO'],
              translationConfig: {
                targetLanguageCode: tokenPayload.target_language_code,
                echoTargetLanguage: tokenPayload.echo_target_language,
              },
            },
            realtimeInputConfig: {
              automaticActivityDetection: {
                disabled: false,
                startOfSpeechSensitivity: startSensitivity,
                endOfSpeechSensitivity: endSensitivity,
                prefixPaddingMs,
                silenceDurationMs,
              },
              activityHandling,
              turnCoverage,
            },
          },
        };
        if (inputTranscriptEnabled) setupPayload.setup.inputAudioTranscription = {};
        if (outputTranscriptEnabled) setupPayload.setup.outputAudioTranscription = {};
        ws.send(JSON.stringify(setupPayload));
        setupSentRef.current = true;
        if (setupCompleteTimerRef.current) clearTimeout(setupCompleteTimerRef.current);
        setupCompleteTimerRef.current = setTimeout(() => {
          if (setupCompleteRef.current) return;
          recordEvent('server.setup_complete_timeout', {
            delay_ms: SETUP_COMPLETE_LOG_MS,
            queued_chunks: queuedPcmChunksRef.current.length,
            captured_chunks: sourcePcmChunksRef.current.length,
            sent_chunks: sentAudioLogCountRef.current,
            ws_ready_state: wsRef.current?.readyState,
          });
          setMonitor((prev) => ({
            ...prev,
            queuedChunks: queuedPcmChunksRef.current.length,
            lastEvent: 'setupComplete not received yet',
          }));
        }, SETUP_COMPLETE_LOG_MS);
        recordEvent('websocket.setup_sent', {
          model: tokenPayload.model_resource,
          target_language_code: tokenPayload.target_language_code,
          endpoint: 'BidiGenerateContentConstrained',
          token_query_param: 'access_token',
          shape: 'setup.github_live_translate_hybrid',
          setup_payload: setupPayload,
        });
        setMonitor((prev) => ({ ...prev, setup: 'sent', lastEvent: 'setup sent; waiting for setupComplete' }));
        if (stopRequestedRef.current) {
          recordEvent('stream.stop_already_requested_waiting_setup', { queued_chunks: queuedPcmChunksRef.current.length });
          setStatus('draining');
          scheduleWebSocketClose('stop_wait_for_setup_complete_after_early_stop', STOP_SETUP_WAIT_MS);
        }
      };
      ws.onmessage = (event) => { void handleLiveMessage(event.data); };
      ws.onerror = () => {
        recordEvent('websocket.error');
        setError('Live Translate WebSocket failed.');
        setMonitor((prev) => ({ ...prev, lastEvent: 'websocket error' }));
        if (localCaptureActiveRef.current) setStatus('recording');
        else setStatus('stopped');
      };
      ws.onclose = (event) => {
        const closeNote = event.code || event.reason ? `websocket closed ${event.code}${event.reason ? ` · ${event.reason}` : ''}` : 'websocket closed';
        recordEvent('websocket.closed', {
          code: event.code,
          reason: event.reason,
          was_clean: event.wasClean,
          setup_sent: setupSentRef.current,
          setup_complete: setupCompleteRef.current,
          queued_chunks: queuedPcmChunksRef.current.length,
          stop_requested: stopRequestedRef.current,
        });
        setupSentRef.current = false;
        setupCompleteRef.current = false;
        if (setupCompleteTimerRef.current) clearTimeout(setupCompleteTimerRef.current);
        setupCompleteTimerRef.current = null;
        stopRequestedRef.current = false;
        clearWait();
        setMonitor((prev) => ({ ...prev, websocket: 'closed', lastEvent: closeNote }));
        setStatus((current) => (localCaptureActiveRef.current && (current === 'live' || current === 'connecting' || current === 'recording') ? 'recording' : 'stopped'));
      };
    } catch (exc) {
      recordEvent('stream.start_failed', { message: exc instanceof Error ? exc.message : String(exc) });
      cleanup();
      beginWait('Start failed', undefined, exc instanceof Error ? exc.message : String(exc), 'danger');
      setStatus('stopped');
      const message = exc instanceof Error ? exc.message : 'Live Translate start failed.';
      setError(message);
      setMonitor((prev) => ({ ...prev, token: prev.token === 'requesting' ? 'failed' : prev.token, mic: prev.mic === 'active' ? 'stopped' : prev.mic, lastEvent: message }));
    }
  }

  function setupLocalAudioPipeline(stream: MediaStream, inputCtx: AudioContext) {
    const source = inputCtx.createMediaStreamSource(stream);
    const processor = inputCtx.createScriptProcessor(2048, 1, 1);
    const zeroGain = inputCtx.createGain();
    zeroGain.gain.value = 0;
    sourceRef.current = source;
    processorRef.current = processor;
    zeroGainRef.current = zeroGain;
    processor.onaudioprocess = (event) => {
      const mono = event.inputBuffer.getChannelData(0);
      const resampled = resampleFloat32(mono, inputCtx.sampleRate, INPUT_SAMPLE_RATE);
      const pcm = floatToPcm16(resampled);
      queuePcm(pcm);
    };
    source.connect(processor);
    processor.connect(zeroGain);
    zeroGain.connect(inputCtx.destination);
  }

  function queuePcm(pcm: Int16Array) {
    const merged = new Int16Array(pendingPcmRef.current.length + pcm.length);
    merged.set(pendingPcmRef.current, 0);
    merged.set(pcm, pendingPcmRef.current.length);
    const chunkMs = audioChunkMsRef.current;
    const chunkSamples = Math.round((INPUT_SAMPLE_RATE * chunkMs) / 1000);
    let offset = 0;
    while (merged.length - offset >= chunkSamples) {
      const chunk = merged.slice(offset, offset + chunkSamples);
      sourcePcmChunksRef.current.push(chunk);
      const levels = pcmLevels(chunk);
      const ws = wsRef.current;
      const canSend = Boolean(ws && ws.readyState === WebSocket.OPEN && setupCompleteRef.current);
      const sent = canSend && ws ? sendAudioChunk(ws, chunk, 'live_capture') : false;
      const queuedCount = sent ? queuedPcmChunksRef.current.length : queueAudioChunk(chunk);
      offset += chunkSamples;
      setMonitor((prev) => ({
        ...prev,
        chunksCaptured: prev.chunksCaptured + 1,
        chunksSent: prev.chunksSent + (sent ? 1 : 0),
        queuedChunks: queuedCount,
        sourceBytes: prev.sourceBytes + chunk.byteLength,
        sourceSeconds: Math.round((prev.sourceSeconds + chunk.length / INPUT_SAMPLE_RATE) * 10) / 10,
        level: levels.rms,
        peak: Math.max(prev.peak, levels.peak),
        lastEvent: sent ? 'audio chunk sent' : 'audio queued before setup',
      }));
      if ((sourcePcmChunksRef.current.length % 25) === 0) {
        recordEvent('audio.capture_progress', {
          chunks_captured: sourcePcmChunksRef.current.length,
          chunks_sent: sent ? undefined : monitor.chunksSent,
          queued_chunks: queuedCount,
          source_seconds: Math.round((sourcePcmChunksRef.current.length * chunkMs) / 100) / 10,
          can_send: sent,
          rms: levels.rms,
          peak: levels.peak,
        });
      }
    }
    pendingPcmRef.current = merged.slice(offset);
  }

  function sendAudioChunk(ws: WebSocket, chunk: Int16Array, reason: string) {
    try {
      const levels = pcmLevels(chunk);
      const base64 = int16ToBase64(chunk);
      ws.send(JSON.stringify({
        realtimeInput: {
          audio: {
            data: base64,
            mimeType: `audio/pcm;rate=${INPUT_SAMPLE_RATE}`,
          },
        },
      }));
      sentAudioLogCountRef.current += 1;
      if (sentAudioLogCountRef.current <= 3 || (sentAudioLogCountRef.current % 25) === 0) {
        recordEvent('audio.chunk_sent_sample', {
          index: sentAudioLogCountRef.current,
          reason,
          samples: chunk.length,
          bytes: chunk.byteLength,
          base64_chars: base64.length,
          rms: levels.rms,
          peak: levels.peak,
          buffered_amount: ws.bufferedAmount,
        });
      }
      return true;
    } catch (exc) {
      recordEvent('audio.send_failed', { reason, message: exc instanceof Error ? exc.message : String(exc) });
      return false;
    }
  }

  function queueAudioChunk(chunk: Int16Array) {
    queuedPcmChunksRef.current.push(chunk);
    let dropped = 0;
    while (queuedPcmChunksRef.current.length > MAX_QUEUED_AUDIO_CHUNKS) {
      queuedPcmChunksRef.current.shift();
      dropped += 1;
    }
    if (dropped > 0) {
      recordEvent('audio.queue_trimmed', { dropped, remaining: queuedPcmChunksRef.current.length });
    }
    return queuedPcmChunksRef.current.length;
  }

  function flushQueuedAudio(reason: string) {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !setupCompleteRef.current) return 0;
    const queue = queuedPcmChunksRef.current;
    queuedPcmChunksRef.current = [];
    let sent = 0;
    for (const chunk of queue) {
      if (!sendAudioChunk(ws, chunk, reason)) {
        queuedPcmChunksRef.current = queue.slice(sent);
        break;
      }
      sent += 1;
    }
    recordEvent('audio.queue_flushed', {
      reason,
      chunks: sent,
      remaining: queuedPcmChunksRef.current.length,
    });
    setMonitor((prev) => ({
      ...prev,
      chunksSent: prev.chunksSent + sent,
      queuedChunks: queuedPcmChunksRef.current.length,
      lastEvent: sent ? `queued audio flushed ${sent}` : prev.lastEvent,
    }));
    return sent;
  }

  function scheduleWebSocketClose(reason: string, delayMs: number) {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    const readableReason = reason.includes('response_drain') ? 'Waiting for final output' : 'Waiting before closing';
    beginWait(readableReason, delayMs, reason.replaceAll('_', ' '), 'warning');
    recordEvent('websocket.close_scheduled', { reason, delay_ms: delayMs });
    closeTimerRef.current = setTimeout(() => {
      recordEvent('websocket.close_timer_fired', {
        reason,
        ready_state: wsRef.current?.readyState,
        setup_complete: setupCompleteRef.current,
        setup_sent: setupSentRef.current,
        queued_chunks: queuedPcmChunksRef.current.length,
      });
      if (wsRef.current && wsRef.current.readyState <= WebSocket.OPEN) wsRef.current.close();
      wsRef.current = null;
    }, delayMs);
  }

  function finishWithoutOpenSocket(reason: string, readyState?: number) {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
    if (wsRef.current && wsRef.current.readyState !== WebSocket.CONNECTING && wsRef.current.readyState !== WebSocket.OPEN) {
      wsRef.current = null;
    }
    setupSentRef.current = false;
    setupCompleteRef.current = false;
    stopRequestedRef.current = false;
    recordEvent('stream.stop_finalized_without_open_socket', {
      reason,
      ready_state: readyState,
      queued_chunks: queuedPcmChunksRef.current.length,
      sent_chunks: monitor.chunksSent,
    });
    setMonitor((prev) => ({
      ...prev,
      websocket: readyState === WebSocket.CLOSED || readyState === WebSocket.CLOSING ? 'closed' : prev.websocket,
      queuedChunks: queuedPcmChunksRef.current.length,
      lastEvent: reason,
    }));
    clearWait();
    setStatus('stopped');
  }

  function scheduleStopWithoutSocketTimeout(reason: string, delayMs: number) {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    beginWait('Waiting for socket', delayMs, 'Stop was requested before the socket became ready.', 'warning');
    recordEvent('stream.stop_wait_timeout_scheduled', { reason, delay_ms: delayMs });
    closeTimerRef.current = setTimeout(() => {
      finishWithoutOpenSocket(reason, wsRef.current?.readyState);
    }, delayMs);
  }

  function sendAudioStreamEnd(reason: string) {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !setupCompleteRef.current) return false;
    const queuedBefore = queuedPcmChunksRef.current.length;
    const flushed = flushQueuedAudio(reason);
    ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
    recordEvent('audio.stream_end_sent', {
      reason,
      queued_before: queuedBefore,
      queued_flushed: flushed,
      queued_after: queuedPcmChunksRef.current.length,
      buffered_amount: ws.bufferedAmount,
    });
    setMonitor((prev) => ({ ...prev, queuedChunks: queuedPcmChunksRef.current.length, lastEvent: 'audio stream end sent' }));
    scheduleWebSocketClose('response_drain_after_audio_end', responseDrainMsRef.current);
    return true;
  }

  async function decodeLiveMessagePayload(raw: string | Blob | ArrayBuffer) {
    if (typeof raw === 'string') return { text: raw, payload_type: 'string' };
    if (raw instanceof Blob) return { text: await raw.text(), payload_type: 'blob', size: raw.size, type: raw.type };
    if (raw instanceof ArrayBuffer) return { text: new TextDecoder().decode(raw), payload_type: 'array_buffer', size: raw.byteLength };
    return { text: String(raw), payload_type: typeof raw };
  }

  async function handleLiveMessage(raw: string | Blob | ArrayBuffer) {
    const decoded = await decodeLiveMessagePayload(raw);
    let message: LiveMessage;
    try {
      message = JSON.parse(decoded.text) as LiveMessage;
    } catch (exc) {
      recordEvent('server.message_parse_failed', {
        payload_type: decoded.payload_type,
        message: exc instanceof Error ? exc.message : String(exc),
        ...summarizeRawPayload(decoded.text),
      });
      setMonitor((prev) => ({ ...prev, lastEvent: 'server message parse failed' }));
      return;
    }
    serverMessageCountRef.current += 1;
    recordEvent('server.message_received', {
      index: serverMessageCountRef.current,
      payload_type: decoded.payload_type,
      ...(serverMessageCountRef.current <= 5 ? { raw: summarizeRawPayload(decoded.text) } : {}),
      ...summarizeLiveMessage(message),
    });
    setMonitor((prev) => ({ ...prev, serverMessages: serverMessageCountRef.current }));
    if (message.error) {
      recordEvent('server.error', message.error);
      setError(message.error.message || message.error.status || 'Live Translate server error.');
      setMonitor((prev) => ({ ...prev, lastEvent: 'server error' }));
      beginWait('Server error', undefined, message.error.message || message.error.status || 'Live Translate server error.', 'danger');
      return;
    }
    if (message.setupComplete) {
      if (setupCompleteTimerRef.current) clearTimeout(setupCompleteTimerRef.current);
      setupCompleteTimerRef.current = null;
      recordEvent('server.setup_complete');
      setupCompleteRef.current = true;
      const flushed = flushQueuedAudio('setup_complete');
      setStatus(stopRequestedRef.current ? 'draining' : 'live');
      if (!stopRequestedRef.current) clearWait();
      setMonitor((prev) => ({ ...prev, setup: 'complete', queuedChunks: queuedPcmChunksRef.current.length, lastEvent: 'setup complete' }));
      recordEvent('server.setup_complete_flush', {
        flushed_chunks: flushed,
        stop_requested: stopRequestedRef.current,
      });
      if (stopRequestedRef.current) sendAudioStreamEnd('stop_after_setup_complete');
    }
    if (message.usageMetadata) {
      recordEvent('server.usage_metadata', message.usageMetadata);
      setMonitor((prev) => ({ ...prev, usage: JSON.stringify(message.usageMetadata), lastEvent: 'usage metadata' }));
    }
    if (message.goAway) {
      recordEvent('server.go_away', message.goAway);
      setMonitor((prev) => ({ ...prev, lastEvent: `goAway ${message.goAway?.timeLeft || ''}`.trim() }));
    }
    const content = message.serverContent;
    if (!content) return;
    appendSegment('input', content.inputTranscription?.text || '', content.inputTranscription?.languageCode);
    appendSegment('output', content.outputTranscription?.text || '', content.outputTranscription?.languageCode);
    if (content.inputTranscription?.text || content.outputTranscription?.text) {
      recordEvent('server.transcription', {
        input: content.inputTranscription,
        output: content.outputTranscription,
      });
    }
    const parts = content.modelTurn?.parts || [];
    parts.forEach((part) => {
      const data = part.inlineData?.data;
      const mime = part.inlineData?.mimeType || '';
      if (!data || !mime.startsWith('audio/')) return;
      const pcm = base64ToInt16(data);
      recordEvent('server.target_audio', { samples: pcm.length, mime });
      targetPcmChunksRef.current.push(pcm);
      setMonitor((prev) => ({
        ...prev,
        targetChunks: prev.targetChunks + 1,
        targetSeconds: Math.round((prev.targetSeconds + pcm.length / OUTPUT_SAMPLE_RATE) * 10) / 10,
        lastEvent: 'target audio received',
      }));
      const ctx = outputAudioCtxRef.current;
      if (!ctx) return;
      const startAt = Math.max(ctx.currentTime, playCursorRef.current || 0);
      const duration = playPcm16Chunk(ctx, pcm, OUTPUT_SAMPLE_RATE, startAt);
      playCursorRef.current = startAt + duration;
    });
  }

  function stopStream() {
    stopRequestedRef.current = true;
    recordEvent('stream.stop_clicked', {
      status,
      setup_complete: setupCompleteRef.current,
      setup_sent: setupSentRef.current,
      queued_chunks: queuedPcmChunksRef.current.length,
      ws_ready_state: wsRef.current?.readyState,
    });
    processorRef.current?.disconnect();
    sourceRef.current?.disconnect();
    zeroGainRef.current?.disconnect();
    processorRef.current = null;
    sourceRef.current = null;
    zeroGainRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    localCaptureActiveRef.current = false;
    setMonitor((prev) => ({ ...prev, mic: prev.mic === 'active' ? 'stopped' : prev.mic }));
    const wsReadyState = wsRef.current?.readyState;
    if (wsReadyState === WebSocket.OPEN) {
      if (setupCompleteRef.current) {
        sendAudioStreamEnd(setupCompleteRef.current ? 'manual_stop_setup_complete' : 'manual_stop_setup_sent');
      } else {
        recordEvent('stream.stop_waiting_for_setup', { queued_chunks: queuedPcmChunksRef.current.length });
        setMonitor((prev) => ({
          ...prev,
          queuedChunks: queuedPcmChunksRef.current.length,
          lastEvent: 'stop waiting for setupComplete',
        }));
        scheduleWebSocketClose('stop_wait_for_setup_timeout', STOP_SETUP_WAIT_MS);
      }
    } else {
      recordEvent('stream.stop_waiting_for_token_or_socket', {
        queued_chunks: queuedPcmChunksRef.current.length,
        ws_ready_state: wsReadyState,
      });
      if (wsReadyState === WebSocket.CONNECTING || (!wsRef.current && status === 'connecting')) {
        setMonitor((prev) => ({
          ...prev,
          queuedChunks: queuedPcmChunksRef.current.length,
          lastEvent: 'stop waiting for token/socket',
        }));
        scheduleStopWithoutSocketTimeout('stop_wait_for_token_or_socket_timeout', STOP_SETUP_WAIT_MS);
        setStatus('draining');
      } else {
        finishWithoutOpenSocket('stopped; socket not open', wsReadyState);
      }
    }
    void inputAudioCtxRef.current?.close();
    inputAudioCtxRef.current = null;
  }

  function storedAudioSrc(kind: 'source' | 'target') {
    if (!sessionDetail) return null;
    if (kind === 'source') {
      return sessionDetail.source_audio_url || audioDataUrl(sessionDetail.source_audio_base64, sessionDetail.source_audio_mime_type);
    }
    return sessionDetail.target_audio_url || audioDataUrl(sessionDetail.target_audio_base64, sessionDetail.target_audio_mime_type);
  }

  async function playStoredAudio(kind: 'source' | 'target') {
    const src = storedAudioSrc(kind);
    if (!src) return;
    const audio = new Audio(src);
    await audio.play();
  }

  async function replayAudio(kind: 'source' | 'target') {
    const chunks = kind === 'source' ? sourcePcmChunksRef.current : targetPcmChunksRef.current;
    if (!chunks.length) {
      await playStoredAudio(kind);
      return;
    }
    const sampleRate = kind === 'source' ? INPUT_SAMPLE_RATE : OUTPUT_SAMPLE_RATE;
    const ctx = outputAudioCtxRef.current || new AudioContext();
    outputAudioCtxRef.current = ctx;
    if (ctx.state === 'suspended') await ctx.resume();
    let cursor = ctx.currentTime;
    chunks.forEach((chunk) => {
      const duration = playPcm16Chunk(ctx, chunk, sampleRate, cursor);
      cursor += duration;
    });
  }

  async function saveSession() {
    setStatus('saving');
    setError(null);
    beginWait('Saving session', undefined, 'Writing transcripts, audio and logs to GCS.', 'info');
    try {
      const runtimeSettings = currentRuntimeSettings(activeSettingsProfile);
      const savedProfile = readStoredSettingsProfile(activeSettingsProfile);
      const sessionId = saved ? nowId() : sessionIdRef.current;
      sessionIdRef.current = sessionId;
      const sourceAudio = sourcePcmChunksRef.current.length
        ? pcm16ChunksToWavBase64(sourcePcmChunksRef.current, INPUT_SAMPLE_RATE)
        : undefined;
      const targetAudio = targetPcmChunksRef.current.length
        ? pcm16ChunksToWavBase64(targetPcmChunksRef.current, OUTPUT_SAMPLE_RATE)
        : undefined;
      const response = await saveLiveTranslateSession({
        session_id: sessionId,
        target_language_code: targetLang,
        source_language_code: inputSegmentsRef.current.find((item) => item.language_code !== 'auto')?.language_code || 'auto',
        echo_target_language: echoTarget,
        input_transcript: toPayload(inputSegmentsRef.current),
        output_transcript: toPayload(outputSegmentsRef.current),
        source_audio_wav_base64: sourceAudio,
        target_audio_wav_base64: targetAudio,
        metadata: {
          source: 'admin_console_routine_tester',
          monitor,
          settings_profile: {
            key: activeSettingsProfile,
            label: profileLabel(activeSettingsProfile),
            source: savedProfile ? 'saved_profile' : 'current_unsaved_values',
            saved_at: savedProfile?.savedAt || null,
          },
          runtime_settings: runtimeSettings,
          frontend_log: eventLogRef.current,
        },
      });
      setSaved(response);
      setLastSessionId(response.session_id);
      await loadSavedSessions(response.session_id);
      clearWait();
      setStatus('stopped');
    } catch (exc) {
      setStatus('stopped');
      setError(exc instanceof Error ? exc.message : 'Save session failed.');
      beginWait('Save failed', undefined, exc instanceof Error ? exc.message : 'Save session failed.', 'danger');
    }
  }

  function restoreSessionToWorkspace(detail: LiveTranslateSessionDetailResponse) {
    cleanup();
    sessionIdRef.current = detail.session_id;
    segmentIdRef.current = 0;
    const session = isRecord(detail.session) ? detail.session : {};
    const metadata = isRecord(session.metadata) ? session.metadata : {};
    const savedRuntime = isRecord(metadata.runtime_settings) ? metadata.runtime_settings : {};
    const settingsProfile = isRecord(metadata.settings_profile) ? metadata.settings_profile : {};
    const savedMonitor = isRecord(metadata.monitor) ? metadata.monitor : {};
    const input = (detail.input_transcript || []).map((item) => {
      segmentIdRef.current += 1;
      return {
        id: segmentIdRef.current,
        text: compactText(item.text),
        language_code: item.language_code || 'auto',
        created_at: item.created_at || new Date().toISOString(),
      };
    }).filter((item) => item.text);
    const output = (detail.output_transcript || []).map((item) => {
      segmentIdRef.current += 1;
      return {
        id: segmentIdRef.current,
        text: compactText(item.text),
        language_code: item.language_code || String(session.target_language_code || targetLang),
        created_at: item.created_at || new Date().toISOString(),
      };
    }).filter((item) => item.text);
    sourcePcmChunksRef.current = [];
    targetPcmChunksRef.current = [];
    playCursorRef.current = 0;
    syncInput(input);
    syncOutput(output);
    setEchoTarget(Boolean(session.echo_target_language ?? savedRuntime.echoTarget ?? false));
    if (Object.keys(savedRuntime).length) applyRuntimeSettings(savedRuntime, { persistTarget: false });
    if (SETTINGS_PROFILE_KEYS.includes(settingsProfile.key as SettingsProfileKey)) {
      setActiveSettingsProfile(settingsProfile.key as SettingsProfileKey);
      setLastProfileNotice(`Restored ${settingsProfile.label || profileLabel(settingsProfile.key as SettingsProfileKey)} profile from session`);
    }
    setMonitor({
      ...defaultMonitor(),
      token: 'restored',
      websocket: 'closed',
      setup: 'complete',
      mic: 'stopped',
      chunksCaptured: clampNumber(savedMonitor.chunksCaptured, 0, 0, Number.MAX_SAFE_INTEGER),
      chunksSent: clampNumber(savedMonitor.chunksSent, 0, 0, Number.MAX_SAFE_INTEGER),
      queuedChunks: clampNumber(savedMonitor.queuedChunks, 0, 0, Number.MAX_SAFE_INTEGER),
      sourceSeconds: clampNumber(savedMonitor.sourceSeconds, 0, 0, Number.MAX_SAFE_INTEGER),
      sourceBytes: clampNumber(savedMonitor.sourceBytes, 0, 0, Number.MAX_SAFE_INTEGER),
      level: clampNumber(savedMonitor.level, 0, 0, 100),
      peak: clampNumber(savedMonitor.peak, 0, 0, 100),
      targetChunks: clampNumber(savedMonitor.targetChunks, 0, 0, Number.MAX_SAFE_INTEGER),
      targetSeconds: clampNumber(savedMonitor.targetSeconds, 0, 0, Number.MAX_SAFE_INTEGER),
      serverMessages: clampNumber(savedMonitor.serverMessages, 0, 0, Number.MAX_SAFE_INTEGER),
      lastEvent: `restored ${detail.session_id}`,
      usage: usageStringFromUnknown(savedMonitor.usage),
    });
    setSaved({
      status: 'restored',
      bucket: detail.bucket,
      session_id: detail.session_id,
      prefix: detail.prefix,
      saved_paths: [],
    });
    setLastSessionId(detail.session_id);
    setError(null);
    setStatus('stopped');
    clearWait();
    recordEvent('session.restored_to_workspace', { session_id: detail.session_id });
  }

  async function loadSavedSessions(selectSessionId?: string, options?: { autoSelectLatest?: boolean }) {
    setSessionBrowserStatus('loading');
    try {
      const response = await fetchLiveTranslateSessions(10);
      setSavedSessions(response.sessions);
      setSessionBrowserStatus('ready');
      const autoSelectLatest = options?.autoSelectLatest !== false;
      const targetSessionId = selectSessionId || (autoSelectLatest ? response.sessions[0]?.session_id : undefined);
      if (targetSessionId) await loadSessionDetail(targetSessionId);
    } catch (exc) {
      setSessionBrowserStatus(exc instanceof Error ? exc.message : 'Session list failed.');
    }
  }

  async function loadSessionDetail(sessionId: string) {
    setSessionBrowserStatus('loading detail');
    beginWait('Loading saved session', undefined, sessionId, 'info');
    try {
      const detail = await fetchLiveTranslateSessionDetail(sessionId);
      setSessionDetail(detail);
      restoreSessionToWorkspace(detail);
      setSessionBrowserStatus('ready');
    } catch (exc) {
      setSessionBrowserStatus(exc instanceof Error ? exc.message : 'Session detail failed.');
      beginWait('Load failed', undefined, exc instanceof Error ? exc.message : 'Session detail failed.', 'danger');
    }
  }

  const canSave = inputSegments.length > 0 || outputSegments.length > 0 || sourcePcmChunksRef.current.length > 0 || targetPcmChunksRef.current.length > 0;
  const isRunning = status === 'connecting' || status === 'recording' || status === 'live' || status === 'draining' || localCaptureActiveRef.current;
  const settingsLocked = isRunning || status === 'saving';
  const waitRemainingMs = waitIndicator?.endsAt ? Math.max(0, waitIndicator.endsAt - clockMs) : null;
  const waitDurationMs = waitIndicator?.endsAt ? Math.max(1, waitIndicator.endsAt - waitIndicator.startedAt) : null;
  const waitProgress = waitRemainingMs !== null && waitDurationMs ? Math.max(0, Math.min(100, 100 - (waitRemainingMs / waitDurationMs) * 100)) : 42;
  const costEstimate = estimateSessionCost(monitor.usage, monitor.sourceSeconds, monitor.targetSeconds);
  const lifecycleTone = error ? 'danger' : waitIndicator ? waitIndicator.tone : status === 'stopped' || status === 'idle' ? 'info' : 'warning';
  const allLanguages = [...(config?.supported_languages || [{ code: 'en', label: 'English' }])]
    .sort((left, right) => languageDisplayLabel(left).localeCompare(languageDisplayLabel(right), 'en', { sensitivity: 'base' }));
  const selectedLanguage = allLanguages.find((lang) => lang.code.toLowerCase() === targetLang.toLowerCase());
  const languageQuery = languageSearch.trim().toLowerCase();
  const matchingLanguages = languageQuery
    ? allLanguages.filter((lang) => languageSearchText(lang).includes(languageQuery))
    : allLanguages;
  const selectLanguages = selectedLanguage && !matchingLanguages.some((lang) => lang.code === selectedLanguage.code)
    ? [selectedLanguage, ...matchingLanguages]
    : matchingLanguages;
  const outputLangBadge = outputSegments[0]?.language_code || targetLang;
  const sourceAudioSrc = storedAudioSrc('source');
  const targetAudioSrc = storedAudioSrc('target');
  const hasPlayableSourceAudio = sourcePcmChunksRef.current.length > 0 || Boolean(sourceAudioSrc);
  const hasPlayableTargetAudio = targetPcmChunksRef.current.length > 0 || Boolean(targetAudioSrc);

  return (
    <div className="live-translate-panel">
      <div className="live-translate-toolbar">
        <div className="live-translate-language-picker">
          <input
            disabled={settingsLocked}
            list="live-translate-language-search-options"
            onChange={(event) => {
              const next = event.target.value;
              setLanguageSearch(next);
              const exact = allLanguages.find((lang) => {
                const display = languageDisplayLabel(lang).toLowerCase();
                return display === next.trim().toLowerCase() || lang.code.toLowerCase() === next.trim().toLowerCase();
              });
              if (exact) setTargetLang(exact.code);
            }}
            placeholder={selectedLanguage ? languageDisplayLabel(selectedLanguage) : 'Search target language'}
            type="search"
            value={languageSearch}
          />
          <datalist id="live-translate-language-search-options">
            {allLanguages.map((lang) => (
              <option key={lang.code} value={languageDisplayLabel(lang)}>{lang.code.toUpperCase()}</option>
            ))}
          </datalist>
          <select
            className="gcs-transcript-llm-select"
            disabled={settingsLocked}
            onChange={(event) => {
              setTargetLang(event.target.value);
              setLanguageSearch('');
            }}
            value={targetLang}
          >
            {selectLanguages.map((lang) => (
              <option key={lang.code} value={lang.code}>{languageDisplayLabel(lang)} · {lang.code}</option>
            ))}
          </select>
        </div>
        <label className="live-translate-check">
          <input
            checked={echoTarget}
            disabled={settingsLocked}
            onChange={(event) => setEchoTarget(event.target.checked)}
            type="checkbox"
          />
          <span>Echo target</span>
        </label>
        <div className="live-translate-status">
          <span className={`live-asr-dot ${status === 'live' ? 'recording' : status === 'connecting' || status === 'saving' ? 'processing' : ''}`} />
          <span>{status === 'idle' ? 'Ready' : status}</span>
          {config?.model && <span className="live-translate-model">{config.model}</span>}
        </div>
      </div>

      <div className={`live-translate-settings-panel ${settingsLocked ? 'locked' : 'editable'}`}>
        <div className="live-translate-settings-head">
          <div>
            <strong>Runtime settings</strong>
            <span>{settingsLocked ? 'Locked while stream/session work is active' : 'Editable before Start and after New session'}</span>
          </div>
          <button className="console-secondary-button" disabled={settingsLocked} onClick={restoreDefaultSettings} type="button">
            <RotateCcw size={15} /> Default settings
          </button>
        </div>
        <div className="live-translate-profile-row">
          <label className="live-translate-setting-tip" data-tip="Active profile name saved into each session. Load applies a saved profile; Save buttons store current values for that OS.">
            <span>Profile</span>
            <select disabled={settingsLocked} onChange={(event) => setActiveSettingsProfile(event.target.value as SettingsProfileKey)} value={activeSettingsProfile}>
              {SETTINGS_PROFILES.map((profile) => (
                <option key={profile.key} value={profile.key}>{profile.label}</option>
              ))}
            </select>
          </label>
          <button className="console-secondary-button" disabled={settingsLocked} onClick={() => loadSettingsProfile(activeSettingsProfile)} type="button">
            Load profile
          </button>
          <div className="live-translate-profile-saves">
            {SETTINGS_PROFILES.map((profile) => (
              <button
                className="console-secondary-button"
                disabled={settingsLocked}
                key={profile.key}
                onClick={() => saveSettingsProfile(profile.key)}
                type="button"
              >
                Save {profile.label}
              </button>
            ))}
          </div>
          {lastProfileNotice && <small>{lastProfileNotice}</small>}
        </div>
        <div className="live-translate-settings-grid">
        <label className="live-translate-setting-tip" data-tip="Client-side PCM packet duration. Range: 100-500ms. Larger values can improve continuity but increase latency.">
          <span>Chunk</span>
          <input
            disabled={settingsLocked}
            max={500}
            min={100}
            onChange={(event) => setAudioChunkMs(Number(event.target.value))}
            step={50}
            type="range"
            value={audioChunkMs}
          />
          <b>{audioChunkMs}ms</b>
        </label>
        <label className="live-translate-setting-tip" data-tip="How long to keep the socket open after Stop. Range: 3000-12000ms. Higher values give final transcript/audio more time.">
          <span>Drain</span>
          <input
            disabled={settingsLocked}
            max={12000}
            min={3000}
            onChange={(event) => setResponseDrainMs(Number(event.target.value))}
            step={500}
            type="range"
            value={responseDrainMs}
          />
          <b>{responseDrainMs}ms</b>
        </label>
        <label className="live-translate-setting-tip" data-tip="Detected silence before speech is ended. Range: 300-2000ms. Higher values preserve pauses but add latency.">
          <span>Silence</span>
          <input
            disabled={settingsLocked}
            max={2000}
            min={300}
            onChange={(event) => setSilenceDurationMs(Number(event.target.value))}
            step={100}
            type="range"
            value={silenceDurationMs}
          />
          <b>{silenceDurationMs}ms</b>
        </label>
        <label className="live-translate-setting-tip" data-tip="Speech padding before start-of-speech is committed. Range: 0-1000ms. Higher values can reduce false starts.">
          <span>Prefix</span>
          <input
            disabled={settingsLocked}
            max={1000}
            min={0}
            onChange={(event) => setPrefixPaddingMs(Number(event.target.value))}
            step={50}
            type="range"
            value={prefixPaddingMs}
          />
          <b>{prefixPaddingMs}ms</b>
        </label>
        <label className="live-translate-setting-tip" data-tip="Start-of-speech sensitivity. High starts faster; Low is more conservative.">
          <span>Start VAD</span>
          <select disabled={settingsLocked} onChange={(event) => setStartSensitivity(event.target.value as StartSensitivity)} value={startSensitivity}>
            <option value="START_SENSITIVITY_HIGH">High</option>
            <option value="START_SENSITIVITY_LOW">Low</option>
          </select>
        </label>
        <label className="live-translate-setting-tip" data-tip="End-of-speech sensitivity. Low waits longer and can keep words together.">
          <span>End VAD</span>
          <select disabled={settingsLocked} onChange={(event) => setEndSensitivity(event.target.value as EndSensitivity)} value={endSensitivity}>
            <option value="END_SENSITIVITY_HIGH">High</option>
            <option value="END_SENSITIVITY_LOW">Low</option>
          </select>
        </label>
        <label className="live-translate-setting-tip" data-tip="Whether new speech interrupts current model output. No interruption can make playback smoother.">
          <span>Activity</span>
          <select disabled={settingsLocked} onChange={(event) => setActivityHandling(event.target.value as ActivityHandling)} value={activityHandling}>
            <option value="START_OF_ACTIVITY_INTERRUPTS">Interrupts</option>
            <option value="NO_INTERRUPTION">No interrupt</option>
          </select>
        </label>
        <label className="live-translate-setting-tip" data-tip="Only activity excludes silence; all input includes pauses and may preserve context with more latency.">
          <span>Coverage</span>
          <select disabled={settingsLocked} onChange={(event) => setTurnCoverage(event.target.value as TurnCoverage)} value={turnCoverage}>
            <option value="TURN_INCLUDES_ONLY_ACTIVITY">Activity</option>
            <option value="TURN_INCLUDES_ALL_INPUT">All input</option>
          </select>
        </label>
        <label className="live-translate-setting-tip" data-tip="Enable source audio transcript events. Turn off only when testing audio-only behavior.">
          <input
            checked={inputTranscriptEnabled}
            disabled={settingsLocked}
            onChange={(event) => setInputTranscriptEnabled(event.target.checked)}
            type="checkbox"
          />
          <span>Source text</span>
        </label>
        <label className="live-translate-setting-tip" data-tip="Enable translated output transcript events. Turn off only when testing audio-only behavior.">
          <input
            checked={outputTranscriptEnabled}
            disabled={settingsLocked}
            onChange={(event) => setOutputTranscriptEnabled(event.target.checked)}
            type="checkbox"
          />
          <span>Target text</span>
        </label>
        </div>
      </div>

      <div className="live-translate-actions">
        {!isRunning ? (
          <button className="live-translate-primary" disabled={!config || status === 'saving'} onClick={() => void startStream()} type="button">
            <Mic size={18} /> Start stream
          </button>
        ) : (
          <button className="live-translate-stop" onClick={stopStream} type="button">
            <Square size={18} /> Stop
          </button>
        )}
        <button className="console-secondary-button" disabled={!canSave || settingsLocked} onClick={() => void saveSession()} type="button">
          <Save size={16} /> Save session
        </button>
        <button className="console-secondary-button" disabled={settingsLocked || !hasPlayableSourceAudio} onClick={() => void replayAudio('source')} type="button">
          <Play size={16} /> Source
        </button>
        <button className="console-secondary-button" disabled={settingsLocked || !hasPlayableTargetAudio} onClick={() => void replayAudio('target')} type="button">
          <Volume2 size={16} /> Target
        </button>
        <button className="console-secondary-button" disabled={settingsLocked} onClick={resetSession} type="button">
          <RotateCcw size={16} /> New session
        </button>
      </div>

      {waitIndicator && (
        <div className={`live-translate-wait live-translate-wait-${waitIndicator.tone}`}>
          <Loader2 className="live-translate-spinner" size={18} />
          <div>
            <strong>{waitIndicator.label}</strong>
            {waitIndicator.detail && <span>{waitIndicator.detail}</span>}
          </div>
          {waitRemainingMs !== null && <b>{Math.ceil(waitRemainingMs / 1000)}s</b>}
          <i style={{ width: `${waitProgress}%` }} />
        </div>
      )}

      <div className="live-translate-boundary">
        <span>Session: {sessionIdRef.current}</span>
        <span>Start: {monitor.chunksCaptured > 0 ? 'captured' : status === 'idle' ? 'ready' : 'arming'}</span>
        <span>End: {status === 'draining' ? 'draining' : monitor.websocket === 'closed' ? 'closed' : status}</span>
        <span>Drain: {responseDrainMs}ms</span>
      </div>

      <div className={`live-translate-monitor live-translate-monitor-${lifecycleTone}`}>
        <span>Token: {monitor.token}</span>
        <span>Auth: {config?.auth?.token_strategy || 'unknown'} / key {config?.auth?.api_key_configured ? 'ok' : 'missing'}</span>
        <span>WS: {monitor.websocket}</span>
        <span>Setup: {monitor.setup}</span>
        <span>Mic: {monitor.mic}</span>
        <span>Captured: {monitor.chunksCaptured} chunks / {monitor.sourceSeconds}s / {(monitor.sourceBytes / 1024).toFixed(1)} KB</span>
        <span>Chunk: {audioChunkMs}ms</span>
        <span>VAD: {startSensitivity.endsWith('HIGH') ? 'S high' : 'S low'} / {endSensitivity.endsWith('HIGH') ? 'E high' : 'E low'} / {silenceDurationMs}ms</span>
        <span>Queued: {monitor.queuedChunks} chunks</span>
        <span>Sent: {monitor.chunksSent} chunks</span>
        <span>Level: {monitor.level}% / peak {monitor.peak}%</span>
        <span>Target: {monitor.targetChunks} chunks / {monitor.targetSeconds}s</span>
        <span>Server: {monitor.serverMessages} msgs</span>
        <span>Last: {monitor.lastEvent}</span>
      </div>
      <div className="live-translate-cost-panel">
        <strong>Usage / cost</strong>
        <span>Input audio tokens: {costEstimate.inputAudioTokens || 'waiting'}</span>
        <span>Output audio tokens: {costEstimate.outputAudioTokens || 'waiting'}</span>
        <span>Total tokens: {costEstimate.totalTokens || 'waiting'}</span>
        <span>Token estimate: {formatUsd(costEstimate.tokenCost)}</span>
        <span>Minute estimate: {formatUsd(costEstimate.minuteCost)}</span>
        <small>
          Paid tier: input ${LIVE_TRANSLATE_PRICING.inputPerMillionTokensUsd}/1M or ${LIVE_TRANSLATE_PRICING.inputPerMinuteUsd}/min; output ${LIVE_TRANSLATE_PRICING.outputPerMillionTokensUsd}/1M or ${LIVE_TRANSLATE_PRICING.outputPerMinuteUsd}/min.
        </small>
      </div>
      {monitor.usage && <pre className="live-translate-usage">{monitor.usage}</pre>}

      {error && <div className="live-asr-error">{error}</div>}

      <div className="live-translate-columns">
        <section className="live-translate-column">
          <div className="live-translate-column-title">
            <span>Input transcript</span>
            <span className="gcs-transcript-lang-badge">AUTO</span>
          </div>
          <TranscriptList segments={inputSegments} emptyText={isRunning ? 'Listening…' : 'No input transcript'} />
        </section>
        <section className="live-translate-column">
          <div className="live-translate-column-title">
            <span>Output transcript</span>
            <span className="gcs-transcript-lang-badge">{outputLangBadge.toUpperCase()}</span>
          </div>
          <TranscriptList segments={outputSegments} emptyText={isRunning ? 'Translating…' : 'No output transcript'} />
        </section>
      </div>

      {targetPcmChunksRef.current.length > 0 && (
        <div className="live-translate-audio-state">
          <Volume2 size={16} />
          <span>{targetPcmChunksRef.current.length} target audio chunks</span>
        </div>
      )}

      {saved && (
        <div className="live-asr-saved-path live-translate-saved">
          <span className="live-asr-saved-label">Saved:</span>
          <code>{saved.prefix}</code>
        </div>
      )}

      <div className="live-translate-session-browser">
        <div className="live-translate-session-browser-head">
          <strong>Saved sessions</strong>
          <button className="console-secondary-button" onClick={() => void loadSavedSessions()} type="button">
            Refresh
          </button>
          <span>{sessionBrowserStatus}</span>
        </div>
        <div className="live-translate-session-list">
          {savedSessions.map((item) => (
            <button
              className={`live-translate-session-item${sessionDetail?.session_id === item.session_id ? ' active' : ''}`}
              key={item.session_id}
              onClick={() => void loadSessionDetail(item.session_id)}
              type="button"
            >
              <span>{item.session_id}</span>
              <small>{item.updated || 'no timestamp'}</small>
            </button>
          ))}
          {!savedSessions.length && <span className="live-translate-empty-inline">No saved sessions</span>}
        </div>
        {sessionDetail && (
          <div className="live-translate-session-detail">
            <div className="live-translate-session-audio">
              <label>
                <span>Source audio</span>
                {sourceAudioSrc ? <audio controls src={sourceAudioSrc} /> : <small>not saved</small>}
              </label>
              <label>
                <span>Target audio</span>
                {targetAudioSrc ? <audio controls src={targetAudioSrc} /> : <small>not saved</small>}
              </label>
            </div>
            <JsonPanel title="session.json" value={sessionDetail.session} />
            <JsonPanel title="input_transcript.json" value={sessionDetail.input_transcript} />
            <JsonPanel title="output_transcript.json" value={sessionDetail.output_transcript} />
            <JsonPanel title="frontend_log.json" value={sessionDetail.frontend_log} />
            <JsonPanel title="backend_log.json" value={sessionDetail.backend_log} />
          </div>
        )}
      </div>
    </div>
  );
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function pcmLevels(chunk: Int16Array) {
  let sumSquares = 0;
  let peak = 0;
  for (let i = 0; i < chunk.length; i += 1) {
    const normalized = Math.abs(chunk[i]) / 32768;
    sumSquares += normalized * normalized;
    if (normalized > peak) peak = normalized;
  }
  return {
    rms: Math.round(Math.sqrt(sumSquares / Math.max(1, chunk.length)) * 100),
    peak: Math.round(peak * 100),
  };
}

function TranscriptList({ segments, emptyText }: { segments: Segment[]; emptyText: string }) {
  if (!segments.length) return <div className="live-translate-empty">{emptyText}</div>;
  return (
    <div className="live-translate-segments">
      {segments.map((segment) => (
        <div className="live-translate-segment" key={segment.id}>
          <span className="gcs-transcript-lang-badge">{segment.language_code.toUpperCase()}</span>
          <p>{segment.text}</p>
        </div>
      ))}
    </div>
  );
}

function JsonPanel({ title, value }: { title: string; value: unknown }) {
  return (
    <details className="live-translate-json-panel" open={title === 'session.json'}>
      <summary>{title}</summary>
      <pre>{JSON.stringify(value ?? null, null, 2)}</pre>
    </details>
  );
}
