// FILE: ~/otmega/otmega_app/console/admin_frontend/src/components/live-translate/LiveTranslatePanel.tsx
// ماموریت: تب Live Translate در Routine Tester؛ گفتار زنده، ترجمه گفتاری، ترنسکریپت و ذخیره session.

import { useEffect, useRef, useState } from 'react';
import { Loader2, Mic, Play, RotateCcw, Save, Square, Volume2 } from 'lucide-react';
import {
  createElevenLabsVoiceProfile,
  fetchConsoleDashboardSettings,
  createLiveTranslateSessionToken,
  fetchLiveTranslateSessionDetail,
  fetchLiveTranslateSessions,
  fetchLiveTranslateConfig,
  fetchLiveTranslateRuntimeSettings,
  executeLiveTranslateClone,
  runLiveTranslateClonePreflight,
  prepareLiveTranslateClonePlan,
  LiveTranslateCloneExecuteResponse,
  LiveTranslateConfigResponse,
  LiveTranslateClonePlanResponse,
  LiveTranslateClonePreflightResponse,
  LiveTranslateRuntimeSettingsResponse,
  LiveTranslateSaveResponse,
  LiveTranslateSavedSession,
  LiveTranslateSessionDetailResponse,
  LiveTranslateSegmentPayload,
  saveConsoleDashboardSettingsSection,
  saveLiveTranslateSession,
  saveLiveTranslateRuntimeSettings,
  fetchLiveConversationGuard,
  updateLiveConversationGuard,
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
type CloneSourceVoiceMode = 'none' | 'google' | 'elevenlabs';
type GoogleCloneMode = 'chirp_instant_custom_voice' | 'gemini_tts_style';
type ElevenLabsCloneMode = 'speech_to_speech' | 'transcript_tts';

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

type ProfileNoticeTone = 'info' | 'success' | 'warning' | 'danger';

type SettingsProfileKey = 'general' | 'ios' | 'android' | 'windows' | 'macos' | 'linux' | 'other';

type RuntimeSettingsSnapshot = typeof DEFAULT_RUNTIME_SETTINGS & {
  savedAt?: string;
  profileKey?: SettingsProfileKey;
  profileLabel?: string;
};

type ElevenLabsVoiceProfile = {
  email: string;
  voice_id: string;
  consent_version?: string;
  source_session_id?: string;
  source_audio_path?: string;
  requires_verification?: boolean;
  created_at?: string;
  updated_at?: string;
};

type PersistedWorkspaceState = {
  last_session_id?: string | null;
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
const CLONE_SOURCE_VOICE_OPTIONS: CloneSourceVoiceMode[] = ['none', 'google', 'elevenlabs'];
const GOOGLE_CLONE_MODE_OPTIONS: GoogleCloneMode[] = ['chirp_instant_custom_voice'];
const ELEVENLABS_CLONE_MODE_OPTIONS: ElevenLabsCloneMode[] = ['speech_to_speech', 'transcript_tts'];
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
  cloneSourceVoiceMode: 'none' as CloneSourceVoiceMode,
  googleCloneMode: 'chirp_instant_custom_voice' as GoogleCloneMode,
  elevenLabsCloneMode: 'speech_to_speech' as ElevenLabsCloneMode,
  cloneSaveAudio: true,
  cloneFallbackToLiveTranslate: true,
  cloneVoiceAlias: '',
  cloneConsentVersion: '',
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

function normalizeEmail(value: unknown) {
  return String(value || '').trim().toLowerCase();
}

function parseElevenLabsVoiceProfiles(value: unknown): ElevenLabsVoiceProfile[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value
    .map((item) => {
      if (!isRecord(item)) return null;
      const email = normalizeEmail(item.email || item.speaker_email);
      const voiceId = String(item.voice_id || '').trim();
      if (!email || !voiceId || seen.has(email)) return null;
      seen.add(email);
      return {
        email,
        voice_id: voiceId,
        consent_version: typeof item.consent_version === 'string' ? item.consent_version : undefined,
        source_session_id: typeof item.source_session_id === 'string' ? item.source_session_id : undefined,
        source_audio_path: typeof item.source_audio_path === 'string' ? item.source_audio_path : undefined,
        requires_verification: typeof item.requires_verification === 'boolean' ? item.requires_verification : undefined,
        created_at: typeof item.created_at === 'string' ? item.created_at : undefined,
        updated_at: typeof item.updated_at === 'string' ? item.updated_at : undefined,
      };
    })
    .filter((item): item is ElevenLabsVoiceProfile => Boolean(item))
    .sort((left, right) => left.email.localeCompare(right.email, 'en', { sensitivity: 'base' }));
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

function cloneModeLabel(mode: CloneSourceVoiceMode) {
  if (mode === 'google') return 'Google clone';
  if (mode === 'elevenlabs') return 'ElevenLabs clone';
  return 'No clone';
}

function googleCloneModeLabel(mode: GoogleCloneMode) {
  if (mode === 'gemini_tts_style') return 'Gemini TTS style';
  return 'Chirp instant custom voice';
}

function elevenLabsCloneModeLabel(mode: ElevenLabsCloneMode) {
  if (mode === 'transcript_tts') return 'Transcript TTS';
  return 'Speech-to-speech';
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
      cloneSourceVoiceMode: CLONE_SOURCE_VOICE_OPTIONS.includes(parsed.cloneSourceVoiceMode as CloneSourceVoiceMode) ? parsed.cloneSourceVoiceMode as CloneSourceVoiceMode : DEFAULT_RUNTIME_SETTINGS.cloneSourceVoiceMode,
      googleCloneMode: GOOGLE_CLONE_MODE_OPTIONS.includes(parsed.googleCloneMode as GoogleCloneMode) ? parsed.googleCloneMode as GoogleCloneMode : DEFAULT_RUNTIME_SETTINGS.googleCloneMode,
      elevenLabsCloneMode: ELEVENLABS_CLONE_MODE_OPTIONS.includes(parsed.elevenLabsCloneMode as ElevenLabsCloneMode) ? parsed.elevenLabsCloneMode as ElevenLabsCloneMode : DEFAULT_RUNTIME_SETTINGS.elevenLabsCloneMode,
      cloneSaveAudio: typeof parsed.cloneSaveAudio === 'boolean' ? parsed.cloneSaveAudio : DEFAULT_RUNTIME_SETTINGS.cloneSaveAudio,
      cloneFallbackToLiveTranslate: typeof parsed.cloneFallbackToLiveTranslate === 'boolean' ? parsed.cloneFallbackToLiveTranslate : DEFAULT_RUNTIME_SETTINGS.cloneFallbackToLiveTranslate,
      cloneVoiceAlias: typeof parsed.cloneVoiceAlias === 'string' ? parsed.cloneVoiceAlias : DEFAULT_RUNTIME_SETTINGS.cloneVoiceAlias,
      cloneConsentVersion: typeof parsed.cloneConsentVersion === 'string' ? parsed.cloneConsentVersion : DEFAULT_RUNTIME_SETTINGS.cloneConsentVersion,
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
  const [cloneSourceVoiceMode, setCloneSourceVoiceMode] = useState<CloneSourceVoiceMode>(() => readOptionSetting('lt_clone_source_voice_mode', DEFAULT_RUNTIME_SETTINGS.cloneSourceVoiceMode, CLONE_SOURCE_VOICE_OPTIONS));
  const [googleCloneMode, setGoogleCloneMode] = useState<GoogleCloneMode>(() => readOptionSetting('lt_google_clone_mode', DEFAULT_RUNTIME_SETTINGS.googleCloneMode, GOOGLE_CLONE_MODE_OPTIONS));
  const [elevenLabsCloneMode, setElevenLabsCloneMode] = useState<ElevenLabsCloneMode>(() => readOptionSetting('lt_elevenlabs_clone_mode', DEFAULT_RUNTIME_SETTINGS.elevenLabsCloneMode, ELEVENLABS_CLONE_MODE_OPTIONS));
  const [cloneSaveAudio, setCloneSaveAudio] = useState(() => readBooleanSetting('lt_clone_save_audio', DEFAULT_RUNTIME_SETTINGS.cloneSaveAudio));
  const [cloneFallbackToLiveTranslate, setCloneFallbackToLiveTranslate] = useState(() => readBooleanSetting('lt_clone_fallback_to_live_translate', DEFAULT_RUNTIME_SETTINGS.cloneFallbackToLiveTranslate));
  const [cloneVoiceAlias, setCloneVoiceAlias] = useState(() => readStringSetting('lt_clone_voice_alias', DEFAULT_RUNTIME_SETTINGS.cloneVoiceAlias));
  const [cloneConsentVersion, setCloneConsentVersion] = useState(() => readStringSetting('lt_clone_consent_version', DEFAULT_RUNTIME_SETTINGS.cloneConsentVersion));
  const [clonePreflight, setClonePreflight] = useState<LiveTranslateClonePreflightResponse | null>(null);
  const [clonePreflightStatus, setClonePreflightStatus] = useState('idle');
  const [clonePlan, setClonePlan] = useState<LiveTranslateClonePlanResponse | null>(null);
  const [clonePlanStatus, setClonePlanStatus] = useState('idle');
  const [cloneExecution, setCloneExecution] = useState<LiveTranslateCloneExecuteResponse | null>(null);
  const [cloneExecutionStatus, setCloneExecutionStatus] = useState('idle');
  const [elevenLabsVoiceProfiles, setElevenLabsVoiceProfiles] = useState<ElevenLabsVoiceProfile[]>([]);
  const [elevenLabsVoiceEmail, setElevenLabsVoiceEmail] = useState('');
  const [voiceProfileStatus, setVoiceProfileStatus] = useState('idle');
  const [activeSettingsProfile, setActiveSettingsProfile] = useState<SettingsProfileKey>(() => readOptionSetting('lt_active_settings_profile', 'general', SETTINGS_PROFILE_KEYS));
  const [lastProfileNotice, setLastProfileNotice] = useState('');
  const [lastProfileNoticeTone, setLastProfileNoticeTone] = useState<ProfileNoticeTone>('info');
  const [liveConvGuardEnabled, setLiveConvGuardEnabled] = useState<boolean | null>(null);
  const [liveConvGuardBusy, setLiveConvGuardBusy] = useState(false);
  const [liveConvGuardUpdatedAt, setLiveConvGuardUpdatedAt] = useState<string>('');
  const [liveConvGuardNotice, setLiveConvGuardNotice] = useState<string>('');
  const [liveConvGuardNoticeTone, setLiveConvGuardNoticeTone] = useState<ProfileNoticeTone>('info');
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

  async function refreshLiveConversationGuard(reason: string) {
    setLiveConvGuardBusy(true);
    recordEvent('live_conversation_guard.read_requested', { reason });
    try {
      const data = await fetchLiveConversationGuard();
      const enabled = Boolean(data.guard?.enabled);
      setLiveConvGuardEnabled(enabled);
      setLiveConvGuardUpdatedAt(String(data.guard?.updated_at || ''));
      setLiveConvGuardNotice(enabled ? 'Feature is ON for app users.' : 'Feature is OFF — new app sessions are blocked.');
      setLiveConvGuardNoticeTone(enabled ? 'success' : 'warning');
      recordEvent('live_conversation_guard.read_result', {
        reason,
        enabled,
        updated_at: data.guard?.updated_at,
        guard_log_tail: (data.log || []).slice(-3),
      });
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : String(exc);
      setLiveConvGuardNotice(`Read failed: ${message}`);
      setLiveConvGuardNoticeTone('danger');
      recordEvent('live_conversation_guard.read_failed', { reason, message });
    } finally {
      setLiveConvGuardBusy(false);
    }
  }

  async function toggleLiveConversationGuard() {
    if (liveConvGuardEnabled === null || liveConvGuardBusy) return;
    const requested = !liveConvGuardEnabled;
    setLiveConvGuardBusy(true);
    recordEvent('live_conversation_guard.toggle_requested', {
      enabled_before: liveConvGuardEnabled,
      requested_enabled: requested,
    });
    try {
      const data = await updateLiveConversationGuard(requested);
      const enabled = Boolean(data.guard?.enabled);
      setLiveConvGuardEnabled(enabled);
      setLiveConvGuardUpdatedAt(String(data.guard?.updated_at || ''));
      setLiveConvGuardNotice(enabled
        ? 'Applied: Live Conversation is ON — app users can start sessions now.'
        : 'Applied: Live Conversation is OFF — token issuing stopped instantly; running sessions end at token expiry.');
      setLiveConvGuardNoticeTone(enabled ? 'success' : 'warning');
      recordEvent('live_conversation_guard.toggle_result', {
        ok: true,
        enabled_after: enabled,
        guard_log_tail: (data.log || []).slice(-3),
      });
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : String(exc);
      setLiveConvGuardNotice(`Change failed — state unchanged. ${message}`);
      setLiveConvGuardNoticeTone('danger');
      recordEvent('live_conversation_guard.toggle_failed', { requested_enabled: requested, message });
    } finally {
      setLiveConvGuardBusy(false);
    }
  }

  useEffect(() => {
    void refreshLiveConversationGuard('panel_mount');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  function setProfileNotice(message: string, tone: ProfileNoticeTone = 'info') {
    setLastProfileNotice(message);
    setLastProfileNoticeTone(tone);
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
    if (CLONE_SOURCE_VOICE_OPTIONS.includes(settings.cloneSourceVoiceMode as CloneSourceVoiceMode)) setCloneSourceVoiceMode(settings.cloneSourceVoiceMode as CloneSourceVoiceMode);
    if (GOOGLE_CLONE_MODE_OPTIONS.includes(settings.googleCloneMode as GoogleCloneMode)) setGoogleCloneMode(settings.googleCloneMode as GoogleCloneMode);
    if (ELEVENLABS_CLONE_MODE_OPTIONS.includes(settings.elevenLabsCloneMode as ElevenLabsCloneMode)) setElevenLabsCloneMode(settings.elevenLabsCloneMode as ElevenLabsCloneMode);
    if (typeof settings.cloneSaveAudio === 'boolean') setCloneSaveAudio(settings.cloneSaveAudio);
    if (typeof settings.cloneFallbackToLiveTranslate === 'boolean') setCloneFallbackToLiveTranslate(settings.cloneFallbackToLiveTranslate);
    if (typeof settings.cloneVoiceAlias === 'string') setCloneVoiceAlias(settings.cloneVoiceAlias);
    if (typeof settings.cloneConsentVersion === 'string') setCloneConsentVersion(settings.cloneConsentVersion);
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
      cloneSourceVoiceMode,
      googleCloneMode,
      elevenLabsCloneMode,
      cloneSaveAudio,
      cloneFallbackToLiveTranslate,
      cloneVoiceAlias,
      cloneConsentVersion,
      savedAt: new Date().toISOString(),
      profileKey,
      profileLabel: profileLabel(profileKey),
    };
  }

  function currentSourceVoiceCloneMetadata(runtimeSettings = currentRuntimeSettings(activeSettingsProfile)) {
    const mode = runtimeSettings.cloneSourceVoiceMode;
    const providerMode = mode === 'google'
      ? runtimeSettings.googleCloneMode
      : mode === 'elevenlabs'
        ? runtimeSettings.elevenLabsCloneMode
        : null;
    const providerReadiness = mode === 'none'
      ? null
      : config?.runtime_controls?.source_voice_clone_providers?.[mode] || null;
    return {
      mode,
      enabled: mode !== 'none',
      provider: mode === 'none' ? null : mode,
      provider_mode: providerMode,
      provider_readiness: providerReadiness,
      provider_preflight: clonePreflight?.provider === mode ? clonePreflight : null,
      setting_profile_key: runtimeSettings.profileKey,
      setting_profile_label: runtimeSettings.profileLabel,
      voice_alias: mode === 'google' ? null : runtimeSettings.cloneVoiceAlias || null,
      voice_profile_email: mode === 'elevenlabs'
        ? elevenLabsVoiceProfiles.find((item) => item.voice_id === runtimeSettings.cloneVoiceAlias)?.email || normalizeEmail(elevenLabsVoiceEmail) || null
        : null,
      consent_version: runtimeSettings.cloneConsentVersion || null,
      save_cloned_audio: runtimeSettings.cloneSaveAudio,
      fallback_to_live_translate_audio: runtimeSettings.cloneFallbackToLiveTranslate,
      fallback_active: false,
      fallback_from: null,
      fallback_to: null,
      fallback_reason: null,
      execution_status: mode === 'none' ? 'off_current_live_translate_path' : 'configured_waiting_for_create_cloned_audio',
      cost_status: mode === 'none' ? 'no_extra_cost' : 'provider_cost_not_estimated_until_execution',
    };
  }

  function selectedCloneProviderMode() {
    if (cloneSourceVoiceMode === 'google') return googleCloneMode;
    if (cloneSourceVoiceMode === 'elevenlabs') return elevenLabsCloneMode;
    return null;
  }

  function selectCloneSourceVoiceMode(mode: CloneSourceVoiceMode) {
    if (mode === cloneSourceVoiceMode) return;
    setCloneSourceVoiceMode(mode);
    setClonePreflightStatus(mode === 'none' ? 'idle' : 'checking');
    recordEvent('clone.mode_selected', {
      from: cloneSourceVoiceMode,
      to: mode,
      session_id: activeSavedSessionId() || sessionIdRef.current || null,
    });
  }

  function activeSavedSessionId() {
    const activeId = sessionIdRef.current;
    const hasActiveSavedSession = saved?.session_id === activeId || sessionDetail?.session_id === activeId;
    if (!hasActiveSavedSession) return '';
    return activeId;
  }

  function applyElevenLabsVoiceProfile(profile: ElevenLabsVoiceProfile) {
    setElevenLabsVoiceEmail(profile.email);
    setCloneVoiceAlias(profile.voice_id);
    if (profile.consent_version) setCloneConsentVersion(profile.consent_version);
    setVoiceProfileStatus(`Selected ${profile.email}`);
    recordEvent('clone.voice_profile_selected', {
      email: profile.email,
      voice_id: profile.voice_id,
      source_session_id: profile.source_session_id || null,
    });
  }

  function upsertElevenLabsVoiceProfile(profile: ElevenLabsVoiceProfile) {
    const normalizedEmail = normalizeEmail(profile.email);
    if (!normalizedEmail || !profile.voice_id.trim()) return elevenLabsVoiceProfiles;
    const now = new Date().toISOString();
    const nextProfile = {
      ...profile,
      email: normalizedEmail,
      voice_id: profile.voice_id.trim(),
      updated_at: now,
      created_at: profile.created_at || now,
    };
    const next = [
      nextProfile,
      ...elevenLabsVoiceProfiles.filter((item) => item.email !== normalizedEmail),
    ].sort((left, right) => left.email.localeCompare(right.email, 'en', { sensitivity: 'base' }));
    setElevenLabsVoiceProfiles(next);
    void persistRuntimeSettingsFile(activeSettingsProfile, next, {
      cloneVoiceAlias: nextProfile.voice_id,
      cloneConsentVersion: nextProfile.consent_version || cloneConsentVersion,
    });
    return next;
  }

  function saveCurrentElevenLabsVoiceProfile() {
    const email = normalizeEmail(elevenLabsVoiceEmail);
    const voiceId = cloneVoiceAlias.trim();
    if (!email || !voiceId) {
      setVoiceProfileStatus('Enter speaker email and voice_id before saving.');
      return;
    }
    const next = upsertElevenLabsVoiceProfile({
      email,
      voice_id: voiceId,
      consent_version: cloneConsentVersion.trim() || undefined,
      source_session_id: activeSavedSessionId() || undefined,
    });
    setVoiceProfileStatus(`Saved voice profile for ${email}`);
    recordEvent('clone.voice_profile_saved', { email, voice_id: voiceId, count: next.length });
  }

  async function createElevenLabsVoiceProfileFromSession() {
    const sessionId = activeSavedSessionId();
    const email = normalizeEmail(elevenLabsVoiceEmail);
    const consentVersion = cloneConsentVersion.trim();
    if (!sessionId) {
      setVoiceProfileStatus('Restore or save a session with Source audio first.');
      return;
    }
    if (!email) {
      setVoiceProfileStatus('Enter speaker email before creating voice_id.');
      return;
    }
    if (!consentVersion) {
      setVoiceProfileStatus('Set voice consent before creating voice_id.');
      return;
    }
    setVoiceProfileStatus('Creating ElevenLabs voice_id...');
    beginWait('Creating voice_id', undefined, email, 'warning');
    try {
      const response = await createElevenLabsVoiceProfile({
        session_id: sessionId,
        speaker_email: email,
        consent_version: consentVersion,
      });
      if (response.status !== 'completed' || !response.voice_id) {
        const detail = [
          response.provider_error_message || response.fallback_reason || response.message || response.blockers?.join(', ') || 'Voice profile creation failed.',
          response.provider_http_status ? `HTTP ${response.provider_http_status}` : '',
          response.provider_error_code ? `Code: ${response.provider_error_code}` : '',
          response.provider_error_type ? `Type: ${response.provider_error_type}` : '',
          response.source_seconds !== undefined && response.min_source_seconds !== undefined ? `Source ${response.source_seconds}s / min ${response.min_source_seconds}s` : '',
          response.provider_error_sample ? `Detail: ${String(response.provider_error_sample).slice(0, 180)}` : '',
          response.next_steps?.length ? `Next: ${response.next_steps.join(' / ')}` : '',
          response.voice_profile_result_path ? `Saved: voice_profile_result.json` : '',
        ].filter(Boolean).join(' | ');
        setVoiceProfileStatus(detail);
        beginWait('Voice profile failed', undefined, detail, 'danger');
        recordEvent('clone.voice_profile_create_blocked', {
          email,
          status: response.status,
          missing: response.missing || [],
          blockers: response.blockers || [],
          provider_http_status: response.provider_http_status || null,
          provider_error_sample: response.provider_error_sample || null,
          provider_error_code: response.provider_error_code || null,
          provider_error_type: response.provider_error_type || null,
          provider_error_status: response.provider_error_status || null,
          next_steps: response.next_steps || [],
          source_seconds: response.source_seconds ?? null,
          min_source_seconds: response.min_source_seconds ?? null,
          voice_profile_result_path: response.voice_profile_result_path || null,
          saved_paths: response.saved_paths || [],
          persist_error: response.persist_error || null,
        });
        return;
      }
      const profile: ElevenLabsVoiceProfile = {
        email,
        voice_id: response.voice_id,
        consent_version: response.consent_version || consentVersion,
        source_session_id: response.session_id || sessionId,
        source_audio_path: response.source_audio_path,
        requires_verification: response.requires_verification,
        created_at: response.created_at || new Date().toISOString(),
      };
      const next = upsertElevenLabsVoiceProfile(profile);
      applyElevenLabsVoiceProfile(profile);
      setVoiceProfileStatus(`Created voice_id for ${email}`);
      clearWait();
      recordEvent('clone.voice_profile_created', {
        email,
        voice_id: response.voice_id,
        count: next.length,
        requires_verification: response.requires_verification || false,
        voice_profile_result_path: response.voice_profile_result_path || null,
        saved_paths: response.saved_paths || [],
      });
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : 'Voice profile creation failed.';
      setVoiceProfileStatus(message);
      beginWait('Voice profile failed', undefined, message, 'danger');
      recordEvent('clone.voice_profile_create_failed', { email, message });
    }
  }

  async function checkCloneProviderPreflight() {
    if (cloneSourceVoiceMode === 'none') {
      setClonePreflight(null);
      setClonePreflightStatus('idle');
      return;
    }
    setClonePreflightStatus('checking');
    try {
      const response = await runLiveTranslateClonePreflight({
        provider: cloneSourceVoiceMode,
        provider_mode: selectedCloneProviderMode(),
        target_language_code: targetLang,
        voice_alias: cloneSourceVoiceMode === 'google' ? '' : cloneVoiceAlias,
      });
      setClonePreflight(response);
      setClonePreflightStatus(response.ready ? 'ready' : 'fallback');
      recordEvent('clone.preflight_checked', { ...response });
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : 'Clone preflight failed.';
      setClonePreflightStatus(message);
      setClonePreflight({
        status: 'error',
        provider: cloneSourceVoiceMode,
        provider_mode: selectedCloneProviderMode(),
        ready: false,
        can_execute: false,
        fallback_active: true,
        fallback_reason: message,
        missing: [],
        blockers: ['preflight_request_failed'],
        next_steps: [message],
        checked_at: new Date().toISOString(),
      });
      recordEvent('clone.preflight_failed', { provider: cloneSourceVoiceMode, message });
    }
  }

  async function prepareClonePlan() {
    const sessionId = activeSavedSessionId();
    if (!sessionId || cloneSourceVoiceMode === 'none') {
      setClonePlanStatus('save session first');
      return;
    }
    setClonePlanStatus('preparing');
    try {
      const response = await prepareLiveTranslateClonePlan({
        session_id: sessionId,
        provider: cloneSourceVoiceMode,
        provider_mode: selectedCloneProviderMode(),
        target_language_code: targetLang,
        voice_alias: cloneSourceVoiceMode === 'google' ? '' : cloneVoiceAlias,
        consent_version: cloneConsentVersion,
        save_cloned_audio: cloneSaveAudio,
        fallback_to_live_translate_audio: cloneFallbackToLiveTranslate,
      });
      setClonePlan(response);
      setClonePlanStatus(response.plan?.status ? String(response.plan.status) : response.status);
      recordEvent('clone.plan_prepared', { ...response, plan: undefined, saved_paths: response.saved_paths });
      if (response.session_id) await loadSessionDetail(response.session_id);
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : 'Clone plan failed.';
      setClonePlanStatus(message);
      setClonePlan({
        status: 'error',
        message,
        session_id: sessionId,
        plan: {
          status: 'error',
          provider: cloneSourceVoiceMode,
          provider_mode: selectedCloneProviderMode(),
          blockers: ['clone_plan_request_failed'],
        },
      });
      recordEvent('clone.plan_failed', { provider: cloneSourceVoiceMode, session_id: sessionId, message });
    }
  }

  async function runCloneExecution() {
    if (cloneSourceVoiceMode === 'elevenlabs' && !cloneVoiceAlias.trim()) {
      const message = 'Enter an approved ElevenLabs voice_id before creating cloned audio.';
      setCloneExecutionStatus('elevenlabs_voice_id_missing');
      setCloneExecution({
        status: 'blocked',
        session_id: activeSavedSessionId() || sessionIdRef.current,
        result: {
          status: 'blocked_fallback_to_no_clone',
          provider: 'elevenlabs',
          provider_mode: selectedCloneProviderMode(),
          fallback_reason: 'elevenlabs_voice_id_missing',
          missing: ['ElevenLabs voice_id'],
          blockers: ['elevenlabs_voice_id_missing'],
          next_steps: [message],
        },
      });
      beginWait('Clone blocked', undefined, message, 'danger');
      recordEvent('clone.execution_blocked', { provider: cloneSourceVoiceMode, reason: 'elevenlabs_voice_id_missing' });
      return;
    }
    let sessionId = activeSavedSessionId();
    if (!sessionId || cloneSourceVoiceMode === 'none') {
      if (cloneSourceVoiceMode === 'none') {
        setCloneExecutionStatus('select clone provider');
        return;
      }
      const savedResponse = await saveSession();
      sessionId = savedResponse?.session_id || '';
      if (!sessionId) {
        setCloneExecutionStatus('save session failed');
        return;
      }
    }
    setCloneExecutionStatus('running');
    beginWait('Running voice clone', undefined, cloneModeLabel(cloneSourceVoiceMode), 'warning');
    try {
      const response = await executeLiveTranslateClone({
        session_id: sessionId,
        provider: cloneSourceVoiceMode,
        provider_mode: selectedCloneProviderMode(),
        target_language_code: targetLang,
        voice_alias: cloneSourceVoiceMode === 'google' ? '' : cloneVoiceAlias,
        consent_version: cloneConsentVersion,
        save_cloned_audio: cloneSaveAudio,
        fallback_to_live_translate_audio: cloneFallbackToLiveTranslate,
        client_context: {
          active_session_id: sessionId,
          session_ref_id: sessionIdRef.current,
          saved_session_id: saved?.session_id || null,
          session_detail_id: sessionDetail?.session_id || null,
          clone_source_voice_mode: cloneSourceVoiceMode,
          selected_provider_mode: selectedCloneProviderMode(),
          session_detail_has_source_audio: Boolean(storedAudioSrc('source')),
          session_detail_has_target_audio: Boolean(storedAudioSrc('target')),
          source_pcm_chunks: sourcePcmChunksRef.current.length,
          target_pcm_chunks: targetPcmChunksRef.current.length,
          saved_paths: saved?.saved_paths || [],
        },
      });
      setCloneExecution(response);
      const resultRecord = isRecord(response.result) ? response.result : {};
      const resultStatus = resultRecord.status ? String(resultRecord.status) : response.status;
      const providerErrorMessage = resultRecord.provider_error_message ? String(resultRecord.provider_error_message) : '';
      const fallbackReason = resultRecord.fallback_reason ? String(resultRecord.fallback_reason) : '';
      const resultMessage = providerErrorMessage || fallbackReason || resultStatus;
      setCloneExecutionStatus(resultStatus);
      recordEvent('clone.execution_finished', {
        status: response.status,
        session_id: response.session_id,
        provider: cloneSourceVoiceMode,
        provider_mode: selectedCloneProviderMode(),
        result_status: resultStatus,
        fallback_reason: fallbackReason || null,
        provider_error_message: providerErrorMessage || null,
        provider_http_status: resultRecord.provider_http_status || null,
        saved_paths: response.saved_paths,
      });
      if (response.session_id) await loadSessionDetail(response.session_id);
      if (resultStatus === 'completed') {
        clearWait();
      } else {
        beginWait('Clone failed', undefined, resultMessage || 'Provider did not create cloned audio.', 'danger');
      }
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : 'Clone execution failed.';
      setCloneExecutionStatus(message);
      setCloneExecution({
        status: 'error',
        message,
        session_id: sessionId,
        result: {
          status: 'error',
          provider: cloneSourceVoiceMode,
          provider_mode: selectedCloneProviderMode(),
          blockers: ['clone_execution_request_failed'],
        },
      });
      beginWait('Clone failed', undefined, message, 'danger');
      recordEvent('clone.execution_failed', { provider: cloneSourceVoiceMode, session_id: sessionId, message });
    }
  }

  function cacheSettingsProfile(profileKey: SettingsProfileKey, snapshot: RuntimeSettingsSnapshot) {
    window.localStorage.setItem(profileStorageKey(profileKey), JSON.stringify(snapshot));
  }

  function applyRuntimeSettingsResponse(response: LiveTranslateRuntimeSettingsResponse) {
    const effectiveSettings = isRecord(response.effective_settings) ? response.effective_settings : {};
    if (Object.keys(effectiveSettings).length) {
      applyRuntimeSettings(effectiveSettings);
      cacheSettingsProfile((response.effective_profile as SettingsProfileKey) || 'general', effectiveSettings as RuntimeSettingsSnapshot);
    }
    const profileKey = String(response.requested_profile || response.active_profile || response.effective_profile || '');
    if (SETTINGS_PROFILE_KEYS.includes(profileKey as SettingsProfileKey)) {
      setActiveSettingsProfile(profileKey as SettingsProfileKey);
    }
    const savedVoiceProfiles = parseElevenLabsVoiceProfiles(response.document?.elevenlabs_voice_profiles);
    setElevenLabsVoiceProfiles(savedVoiceProfiles);
    if (!cloneVoiceAlias && savedVoiceProfiles.length > 0) {
      setElevenLabsVoiceEmail(savedVoiceProfiles[0].email);
      setCloneVoiceAlias(savedVoiceProfiles[0].voice_id);
      if (savedVoiceProfiles[0].consent_version) setCloneConsentVersion(savedVoiceProfiles[0].consent_version);
    }
  }

  async function persistRuntimeSettingsFile(
    profileKey = activeSettingsProfile,
    voiceProfiles = elevenLabsVoiceProfiles,
    overrides: Partial<RuntimeSettingsSnapshot> = {},
  ) {
    const snapshot = { ...currentRuntimeSettings(profileKey), ...overrides };
    cacheSettingsProfile(profileKey, snapshot);
    return saveLiveTranslateRuntimeSettings({
      profile_key: profileKey,
      active_profile: profileKey,
      settings: snapshot as Record<string, unknown>,
      elevenlabs_voice_profiles: voiceProfiles as unknown as Array<Record<string, unknown>>,
    });
  }

  async function saveSettingsProfile(profileKey: SettingsProfileKey) {
    const snapshot = currentRuntimeSettings(profileKey);
    cacheSettingsProfile(profileKey, snapshot);
    setActiveSettingsProfile(profileKey);
    try {
      const response = await saveLiveTranslateRuntimeSettings({
        profile_key: profileKey,
        active_profile: profileKey,
        settings: snapshot as Record<string, unknown>,
        elevenlabs_voice_profiles: elevenLabsVoiceProfiles as unknown as Array<Record<string, unknown>>,
      });
      applyRuntimeSettingsResponse(response);
      setProfileNotice(`Saved ${snapshot.profileLabel} settings to GCS`, 'success');
      recordEvent('settings.profile_saved', {
        profile_key: profileKey,
        profile_label: snapshot.profileLabel,
        saved_at: snapshot.savedAt,
        path: response.path,
      });
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : String(exc);
      setProfileNotice(`Save ${snapshot.profileLabel} failed: ${message}`, 'danger');
      recordEvent('settings.profile_save_failed', { profile_key: profileKey, message });
    }
  }

  async function loadSettingsProfile(profileKey: SettingsProfileKey) {
    try {
      const response = await fetchLiveTranslateRuntimeSettings(profileKey);
      applyRuntimeSettingsResponse(response);
      const effectiveProfile = response.effective_profile as SettingsProfileKey;
      const effectiveLabel = profileLabel(effectiveProfile);
      if (effectiveProfile === profileKey) {
        setProfileNotice(`Loaded ${effectiveLabel} settings from GCS`, 'success');
      } else {
        setProfileNotice(`${profileLabel(profileKey)} not found; loaded ${effectiveLabel} fallback from GCS`, 'warning');
      }
      recordEvent('settings.profile_loaded', {
        requested_profile: profileKey,
        effective_profile: response.effective_profile,
        path: response.path,
      });
    } catch (exc) {
      const cached = readStoredSettingsProfile(profileKey);
      const message = exc instanceof Error ? exc.message : String(exc);
      if (cached) {
        applyRuntimeSettings(cached);
        setActiveSettingsProfile(profileKey);
        setProfileNotice(`Loaded cached ${cached.profileLabel} settings; GCS failed`, 'warning');
        recordEvent('settings.profile_cache_loaded_after_gcs_failed', { profile_key: profileKey, message });
        return;
      }
      setProfileNotice(`${profileLabel(profileKey)} settings unavailable: ${message}`, 'danger');
      recordEvent('settings.profile_load_failed', { profile_key: profileKey, message });
    }
  }

  function restoreDefaultSettings() {
    applyRuntimeSettings(DEFAULT_RUNTIME_SETTINGS);
    setActiveSettingsProfile('general');
    setProfileNotice('Loaded default runtime settings', 'info');
    recordEvent('settings.defaults_loaded', DEFAULT_RUNTIME_SETTINGS);
  }

  async function loadPersistedWorkspaceState() {
    try {
      const runtimeResponse = await fetchLiveTranslateRuntimeSettings();
      applyRuntimeSettingsResponse(runtimeResponse);
      const response = await fetchConsoleDashboardSettings();
      const section = response.settings[DASHBOARD_SETTINGS_SECTION];
      if (!isRecord(section)) return lastSessionId;
      const savedSessionId = typeof section.last_session_id === 'string' && section.last_session_id.trim()
        ? section.last_session_id.trim()
        : lastSessionId;
      if (savedSessionId) setLastSessionId(savedSessionId);
      recordEvent('settings.dashboard_loaded', {
        section: DASHBOARD_SETTINGS_SECTION,
        last_session_id: savedSessionId || null,
        runtime_settings_path: runtimeResponse.path,
        active_profile: runtimeResponse.active_profile,
      });
      return savedSessionId || null;
    } catch (exc) {
      recordEvent('settings.dashboard_load_failed', { message: exc instanceof Error ? exc.message : String(exc) });
      return lastSessionId;
    } finally {
      dashboardSettingsLoadedRef.current = true;
    }
  }

  function persistedWorkspacePayload(nextSessionId = lastSessionId || saved?.session_id || null): PersistedWorkspaceState {
    return {
      last_session_id: nextSessionId,
      updated_at: new Date().toISOString(),
    };
  }

  function persistWorkspaceState() {
    const nextSessionId = lastSessionId || saved?.session_id || null;
    window.localStorage.setItem('lt_last_session_id', nextSessionId || '');
    const payload = persistedWorkspacePayload(nextSessionId);
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
      await loadSavedSessions(preferredSessionId || undefined, { autoSelectLatest: Boolean(preferredSessionId) });
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
  useEffect(() => { window.localStorage.setItem('lt_clone_source_voice_mode', cloneSourceVoiceMode); }, [cloneSourceVoiceMode]);
  useEffect(() => { window.localStorage.setItem('lt_google_clone_mode', googleCloneMode); }, [googleCloneMode]);
  useEffect(() => { window.localStorage.setItem('lt_elevenlabs_clone_mode', elevenLabsCloneMode); }, [elevenLabsCloneMode]);
  useEffect(() => { window.localStorage.setItem('lt_clone_save_audio', String(cloneSaveAudio)); }, [cloneSaveAudio]);
  useEffect(() => { window.localStorage.setItem('lt_clone_fallback_to_live_translate', String(cloneFallbackToLiveTranslate)); }, [cloneFallbackToLiveTranslate]);
  useEffect(() => { window.localStorage.setItem('lt_clone_voice_alias', cloneVoiceAlias); }, [cloneVoiceAlias]);
  useEffect(() => { window.localStorage.setItem('lt_clone_consent_version', cloneConsentVersion); }, [cloneConsentVersion]);

  useEffect(() => {
    setClonePreflight(null);
    setClonePreflightStatus(cloneSourceVoiceMode === 'none' ? 'idle' : 'checking');
    setClonePlan(null);
    setClonePlanStatus('idle');
    setCloneExecution(null);
    setCloneExecutionStatus('idle');
  }, [cloneSourceVoiceMode, googleCloneMode, elevenLabsCloneMode, targetLang, cloneVoiceAlias]);

  useEffect(() => {
    if (cloneSourceVoiceMode === 'none') return undefined;
    let cancelled = false;
    const provider = cloneSourceVoiceMode;
    const providerMode = selectedCloneProviderMode();
    const voiceAlias = provider === 'google' ? '' : cloneVoiceAlias;
    const timer = window.setTimeout(async () => {
      setClonePreflightStatus('checking');
      try {
        const response = await runLiveTranslateClonePreflight({
          provider,
          provider_mode: providerMode,
          target_language_code: targetLang,
          voice_alias: voiceAlias,
        });
        if (cancelled) return;
        setClonePreflight(response);
        setClonePreflightStatus(response.ready ? 'ready' : 'fallback');
        recordEvent('clone.preflight_auto_checked', {
          provider,
          provider_mode: providerMode,
          ready: response.ready,
          blockers: response.blockers || [],
          missing: response.missing || [],
        });
      } catch (exc) {
        if (cancelled) return;
        const message = exc instanceof Error ? exc.message : 'Clone preflight failed.';
        setClonePreflightStatus('fallback');
        setClonePreflight({
          status: 'error',
          provider,
          provider_mode: providerMode,
          ready: false,
          can_execute: false,
          fallback_active: true,
          fallback_reason: message,
          missing: [],
          blockers: ['preflight_request_failed'],
          next_steps: [message],
          checked_at: new Date().toISOString(),
        });
        recordEvent('clone.preflight_auto_failed', { provider, provider_mode: providerMode, message });
      }
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [cloneSourceVoiceMode, googleCloneMode, elevenLabsCloneMode, targetLang, cloneVoiceAlias]);

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
    cloneConsentVersion,
    cloneFallbackToLiveTranslate,
    cloneSaveAudio,
    cloneSourceVoiceMode,
    cloneVoiceAlias,
    echoTarget,
    elevenLabsCloneMode,
    endSensitivity,
    googleCloneMode,
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
    setClonePlan(null);
    setClonePlanStatus('idle');
    setCloneExecution(null);
    setCloneExecutionStatus('idle');
    setError(null);
    setLastSessionId(null);
    window.localStorage.setItem('lt_last_session_id', '');
    saveConsoleDashboardSettingsSection(DASHBOARD_SETTINGS_SECTION, persistedWorkspacePayload(null) as Record<string, unknown>)
      .then(() => recordEvent('settings.dashboard_session_cleared', { reason: 'new_session' }))
      .catch((exc) => recordEvent('settings.dashboard_session_clear_failed', { message: exc instanceof Error ? exc.message : String(exc) }));
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
    setClonePlan(null);
    setClonePlanStatus('idle');
    setCloneExecution(null);
    setCloneExecutionStatus('idle');
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

  function storedAudioSrc(kind: 'source' | 'target' | 'cloned') {
    if (!sessionDetail) return null;
    if (kind === 'source') {
      return sessionDetail.source_audio_url || audioDataUrl(sessionDetail.source_audio_base64, sessionDetail.source_audio_mime_type);
    }
    if (kind === 'cloned') {
      return sessionDetail.target_cloned_audio_url || audioDataUrl(sessionDetail.target_cloned_audio_base64, sessionDetail.target_cloned_audio_mime_type);
    }
    return sessionDetail.target_audio_url || audioDataUrl(sessionDetail.target_audio_base64, sessionDetail.target_audio_mime_type);
  }

  async function playStoredAudio(kind: 'source' | 'target' | 'cloned') {
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

  async function saveSession(): Promise<LiveTranslateSaveResponse | null> {
    setStatus('saving');
    setError(null);
    beginWait('Saving session', undefined, 'Writing transcripts, audio and logs to GCS.', 'info');
    try {
      const runtimeSettings = currentRuntimeSettings(activeSettingsProfile);
      const savedProfile = readStoredSettingsProfile(activeSettingsProfile);
      const sourceVoiceClone = currentSourceVoiceCloneMetadata(runtimeSettings);
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
          source_voice_clone: sourceVoiceClone,
          frontend_log: eventLogRef.current,
        },
      });
      setSaved(response);
      setLastSessionId(response.session_id);
      await loadSavedSessions(response.session_id);
      clearWait();
      setStatus('stopped');
      return response;
    } catch (exc) {
      setStatus('stopped');
      setError(exc instanceof Error ? exc.message : 'Save session failed.');
      beginWait('Save failed', undefined, exc instanceof Error ? exc.message : 'Save session failed.', 'danger');
      return null;
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
    const savedClone = isRecord(metadata.source_voice_clone) ? metadata.source_voice_clone : {};
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
    const runtimeCloneMode = savedRuntime.cloneSourceVoiceMode;
    const metadataCloneMode = savedClone.mode;
    const hasRuntimeCloneMode = CLONE_SOURCE_VOICE_OPTIONS.includes(runtimeCloneMode as CloneSourceVoiceMode);
    const hasMetadataCloneMode = CLONE_SOURCE_VOICE_OPTIONS.includes(metadataCloneMode as CloneSourceVoiceMode);
    if (hasMetadataCloneMode) setCloneSourceVoiceMode(metadataCloneMode as CloneSourceVoiceMode);
    else if (!hasRuntimeCloneMode) setCloneSourceVoiceMode('none');
    if (typeof savedClone.voice_alias === 'string') setCloneVoiceAlias(savedClone.voice_alias);
    if (typeof savedClone.voice_profile_email === 'string') setElevenLabsVoiceEmail(savedClone.voice_profile_email);
    if (typeof savedClone.consent_version === 'string') setCloneConsentVersion(savedClone.consent_version);
    if (typeof savedClone.save_cloned_audio === 'boolean') setCloneSaveAudio(savedClone.save_cloned_audio);
    if (typeof savedClone.fallback_to_live_translate_audio === 'boolean') setCloneFallbackToLiveTranslate(savedClone.fallback_to_live_translate_audio);
    if (metadataCloneMode === 'google' && GOOGLE_CLONE_MODE_OPTIONS.includes(savedClone.provider_mode as GoogleCloneMode)) {
      setGoogleCloneMode(savedClone.provider_mode as GoogleCloneMode);
    }
    if (metadataCloneMode === 'elevenlabs' && ELEVENLABS_CLONE_MODE_OPTIONS.includes(savedClone.provider_mode as ElevenLabsCloneMode)) {
      setElevenLabsCloneMode(savedClone.provider_mode as ElevenLabsCloneMode);
    }
    if (SETTINGS_PROFILE_KEYS.includes(settingsProfile.key as SettingsProfileKey)) {
      setActiveSettingsProfile(settingsProfile.key as SettingsProfileKey);
      setProfileNotice(`Restored ${settingsProfile.label || profileLabel(settingsProfile.key as SettingsProfileKey)} profile from session`, 'info');
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
    if (isRecord(detail.clone_plan)) {
      setClonePlan({ status: 'restored', bucket: detail.bucket, session_id: detail.session_id, prefix: detail.prefix, plan: detail.clone_plan, saved_paths: [`${detail.prefix}/clone_plan.json`] });
      setClonePlanStatus(String(detail.clone_plan.status || 'restored'));
    } else {
      setClonePlan(null);
      setClonePlanStatus('idle');
    }
    if (isRecord(detail.clone_result)) {
      setCloneExecution({ status: 'restored', bucket: detail.bucket, session_id: detail.session_id, prefix: detail.prefix, result: detail.clone_result, saved_paths: [`${detail.prefix}/clone_result.json`] });
      setCloneExecutionStatus(String(detail.clone_result.status || 'restored'));
    } else {
      setCloneExecution(null);
      setCloneExecutionStatus('idle');
    }
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
  const targetClonedAudioSrc = storedAudioSrc('cloned');
  const hasPlayableSourceAudio = sourcePcmChunksRef.current.length > 0 || Boolean(sourceAudioSrc);
  const hasPlayableTargetAudio = targetPcmChunksRef.current.length > 0 || Boolean(targetAudioSrc);
  const activeCloneProviderMode = cloneSourceVoiceMode === 'google'
    ? googleCloneModeLabel(googleCloneMode)
    : cloneSourceVoiceMode === 'elevenlabs'
      ? elevenLabsCloneModeLabel(elevenLabsCloneMode)
      : 'off';
  const selectedCloneProvider = cloneSourceVoiceMode === 'none'
    ? null
    : config?.runtime_controls?.source_voice_clone_providers?.[cloneSourceVoiceMode] || null;
  const cloneProviderCredentialText = !selectedCloneProvider
    ? ''
    : selectedCloneProvider.credential_configured
      ? 'Credential detected'
      : selectedCloneProvider.required_secret_env
        ? `Missing ${selectedCloneProvider.required_secret_env}`
        : 'Credential not confirmed';
  const cloneProviderSetupText = cloneSourceVoiceMode === 'google'
    ? 'Needs Google ADC and backend GOOGLE_TTS_VOICE_CLONING_KEY.'
    : cloneSourceVoiceMode === 'elevenlabs'
      ? 'Needs ELEVENLABS_API_KEY and an approved voice_id.'
      : '';
  const cloneVoiceIdMissing = cloneSourceVoiceMode === 'elevenlabs' && !cloneVoiceAlias.trim();
  const selectedElevenLabsVoiceProfile = elevenLabsVoiceProfiles.find((item) => item.voice_id === cloneVoiceAlias.trim())
    || elevenLabsVoiceProfiles.find((item) => item.email === normalizeEmail(elevenLabsVoiceEmail))
    || null;
  const voiceProfileCreating = voiceProfileStatus === 'Creating ElevenLabs voice_id...';
  const cloneHeaderStatus = cloneSourceVoiceMode === 'none'
    ? 'current path'
    : cloneExecutionStatus === 'running'
      ? 'creating clone'
      : cloneExecutionStatus === 'completed'
        ? 'clone ready'
        : clonePreflightStatus === 'checking'
          ? 'checking setup'
          : cloneVoiceIdMissing
            ? 'voice_id required'
            : clonePreflight?.ready === false
              ? 'setup blocked'
              : clonePreflight?.ready
                ? 'ready to create'
                : 'choose settings';
  const cloneFallbackText = '';
  const clonePreflightClass = cloneExecutionStatus === 'running'
    ? 'running'
    : clonePreflightStatus === 'checking'
      ? 'checking'
      : cloneVoiceIdMissing || clonePreflight?.ready === false || clonePreflight?.fallback_active
        ? 'fallback'
        : selectedCloneProvider?.credential_configured
          ? 'ready'
          : 'fallback';
  const currentSavedSessionId = activeSavedSessionId();
  const rawClonePlanRecord = isRecord(clonePlan?.plan) ? clonePlan.plan : null;
  const rawClonePlanProvider = String(rawClonePlanRecord?.provider || '');
  const rawClonePlanSessionId = String(rawClonePlanRecord?.session_id || clonePlan?.session_id || '');
  const clonePlanMatchesActiveSelection = Boolean(
    rawClonePlanRecord
      && cloneSourceVoiceMode !== 'none'
      && rawClonePlanProvider === cloneSourceVoiceMode
      && rawClonePlanSessionId === currentSavedSessionId,
  );
  const clonePlanRecord = clonePlanMatchesActiveSelection ? rawClonePlanRecord : null;
  const rawCloneExecutionRecord = isRecord(cloneExecution?.result) ? cloneExecution.result : null;
  const rawCloneExecutionProvider = String(rawCloneExecutionRecord?.provider || '');
  const rawCloneExecutionSessionId = String(rawCloneExecutionRecord?.session_id || cloneExecution?.session_id || '');
  const cloneExecutionMatchesActiveSelection = Boolean(
    rawCloneExecutionRecord
      && cloneSourceVoiceMode !== 'none'
      && rawCloneExecutionProvider === cloneSourceVoiceMode
      && rawCloneExecutionSessionId === currentSavedSessionId,
  );
  const cloneExecutionRecord = cloneExecutionMatchesActiveSelection ? rawCloneExecutionRecord : null;
  const cloneExecutionPreflight = isRecord(cloneExecutionRecord?.preflight) ? cloneExecutionRecord.preflight : null;
  const cloneExecutionStatusText = String(cloneExecutionRecord?.status || cloneExecutionStatus);
  const cloneOutputPath = cloneExecutionRecord?.target_cloned_audio_path ? String(cloneExecutionRecord.target_cloned_audio_path) : '';
  const cloneOutputSaved = Boolean(cloneOutputPath && cloneExecution?.saved_paths?.includes(cloneOutputPath));
  const requestedCloneProviderMode = cloneExecutionRecord?.requested_provider_mode
    ? String(cloneExecutionRecord.requested_provider_mode)
    : cloneExecutionPreflight?.requested_provider_mode
      ? String(cloneExecutionPreflight.requested_provider_mode)
      : '';
  const effectiveCloneProviderMode = cloneExecutionRecord?.effective_provider_mode
    ? String(cloneExecutionRecord.effective_provider_mode)
    : cloneExecutionRecord?.provider_mode
      ? String(cloneExecutionRecord.provider_mode)
      : cloneExecutionPreflight?.effective_provider_mode
        ? String(cloneExecutionPreflight.effective_provider_mode)
        : '';
  const cloneProviderModeFallback = Boolean(requestedCloneProviderMode && effectiveCloneProviderMode && requestedCloneProviderMode !== effectiveCloneProviderMode);
  const clonePlanSessionReady = Boolean(currentSavedSessionId);

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
          <button className="console-secondary-button" disabled={settingsLocked} onClick={() => void loadSettingsProfile(activeSettingsProfile)} type="button">
            Load profile
          </button>
          <div className="live-translate-profile-saves">
            {SETTINGS_PROFILES.map((profile) => (
              <button
                className="console-secondary-button"
                disabled={settingsLocked}
                key={profile.key}
                onClick={() => void saveSettingsProfile(profile.key)}
                type="button"
              >
                Save {profile.label}
              </button>
            ))}
          </div>
          {lastProfileNotice && <small className={`live-translate-profile-notice live-translate-profile-notice-${lastProfileNoticeTone}`}>{lastProfileNotice}</small>}
        </div>
        <div className={`live-translate-clone-panel ${cloneSourceVoiceMode === 'none' ? 'off' : 'active'}`}>
          <div className="live-translate-clone-head">
            <div>
              <strong>Source voice clone</strong>
              <span>{cloneSourceVoiceMode === 'none' ? 'Current Gemini Live Translate audio stays unchanged.' : `${cloneModeLabel(cloneSourceVoiceMode)} settings are saved with the session.`}</span>
            </div>
            <span>{cloneHeaderStatus}</span>
          </div>
          <div className="live-translate-clone-modes" role="radiogroup" aria-label="Source voice clone mode">
            {CLONE_SOURCE_VOICE_OPTIONS.map((mode) => (
              <button
                aria-checked={cloneSourceVoiceMode === mode}
                className={cloneSourceVoiceMode === mode ? 'active' : ''}
                disabled={settingsLocked}
                key={mode}
                onClick={() => selectCloneSourceVoiceMode(mode)}
                role="radio"
                type="button"
              >
                {cloneModeLabel(mode)}
              </button>
            ))}
            {cloneFallbackText && <span className="live-translate-clone-fallback">{cloneFallbackText}</span>}
          </div>
          {selectedCloneProvider && (
            <div className={`live-translate-clone-readiness ${clonePreflightClass}`}>
              <strong>{selectedCloneProvider.label || cloneModeLabel(cloneSourceVoiceMode)}</strong>
              <span>{cloneProviderSetupText}</span>
              <span>{cloneProviderCredentialText}</span>
              {clonePreflightStatus === 'checking' && <span>Checking setup...</span>}
              {clonePreflight && clonePreflightStatus !== 'checking' && <span>Preflight: {clonePreflight.ready ? 'ready' : 'blocked'}</span>}
              {clonePreflight?.fallback_reason && <span>Fallback reason: {clonePreflight.fallback_reason}</span>}
              {Array.isArray(clonePreflight?.blockers) && clonePreflight.blockers.length > 0 && <span>Blockers: {clonePreflight.blockers.join(', ')}</span>}
              {Array.isArray(clonePreflight?.missing) && clonePreflight.missing.length > 0 && <span>Missing: {clonePreflight.missing.join(', ')}</span>}
              {Array.isArray(clonePreflight?.next_steps) && clonePreflight.next_steps.length > 0 && <span>Next: {clonePreflight.next_steps.join(' / ')}</span>}
              <button
                className="console-secondary-button"
                disabled={settingsLocked || cloneExecutionStatus === 'running' || !canSave || cloneVoiceIdMissing}
                onClick={() => void runCloneExecution()}
                type="button"
              >
                {cloneExecutionStatus === 'running' && <Loader2 className="live-translate-spinner" size={14} />}
                Create cloned audio
              </button>
              {!canSave && <span>Record or restore a session with output first.</span>}
              {cloneVoiceIdMissing && <span>Enter approved ElevenLabs voice_id.</span>}
            </div>
          )}
          {cloneExecutionRecord && (
            <div className={`live-translate-clone-readiness ${cloneExecutionStatusText.startsWith('completed') ? 'ready' : 'fallback'}`}>
              <strong>Run: {cloneExecutionStatusText}</strong>
              {cloneOutputSaved && <span>Saved: target_cloned.mp3</span>}
              {cloneExecution?.saved_paths?.includes(`${cloneExecution.prefix}/clone_result.json`) && <span>Saved: clone_result.json</span>}
              {cloneOutputPath && <span>{cloneOutputSaved || cloneExecutionStatusText.startsWith('completed') ? 'Output' : 'Planned output'}: {cloneOutputPath}</span>}
              {cloneProviderModeFallback && <span>Mode fallback: {requestedCloneProviderMode} -&gt; {effectiveCloneProviderMode}</span>}
              {cloneExecutionRecord.mode_fallback_reason && <span>Mode fallback reason: {String(cloneExecutionRecord.mode_fallback_reason)}</span>}
              {cloneExecutionRecord.provider_error_message && <span>Error: {String(cloneExecutionRecord.provider_error_message)}</span>}
              {cloneExecutionRecord.fallback_reason && <span>Fallback reason: {String(cloneExecutionRecord.fallback_reason)}</span>}
              {Array.isArray(cloneExecutionRecord.blockers) && cloneExecutionRecord.blockers.length > 0 && <span>Blockers: {cloneExecutionRecord.blockers.join(', ')}</span>}
              {Array.isArray(cloneExecutionRecord.missing) && cloneExecutionRecord.missing.length > 0 && <span>Missing: {cloneExecutionRecord.missing.join(', ')}</span>}
              {Array.isArray(cloneExecutionRecord.next_steps) && cloneExecutionRecord.next_steps.length > 0 && <span>Next: {cloneExecutionRecord.next_steps.join(' / ')}</span>}
              {cloneExecutionRecord.provider_http_status && <span>Provider HTTP: {String(cloneExecutionRecord.provider_http_status)}</span>}
              {cloneExecutionRecord.provider_error_code && <span>Provider code: {String(cloneExecutionRecord.provider_error_code)}</span>}
              {cloneExecutionRecord.provider_error_type && <span>Provider type: {String(cloneExecutionRecord.provider_error_type)}</span>}
              {cloneExecutionRecord.provider_error_sample && <span>Detail: {String(cloneExecutionRecord.provider_error_sample).slice(0, 180)}</span>}
            </div>
          )}
          {cloneSourceVoiceMode !== 'none' && (
            <>
              <div className="live-translate-clone-settings">
                {cloneSourceVoiceMode === 'google' && (
                  <label className="live-translate-setting-tip" data-tip="Real Google clone path. Requires Chirp Instant Custom Voice access and GOOGLE_TTS_VOICE_CLONING_KEY on the backend.">
                    <span>Google mode</span>
                    <select disabled={settingsLocked} onChange={(event) => setGoogleCloneMode(event.target.value as GoogleCloneMode)} value={googleCloneMode}>
                      {GOOGLE_CLONE_MODE_OPTIONS.map((mode) => (
                        <option key={mode} value={mode}>{googleCloneModeLabel(mode)}</option>
                      ))}
                    </select>
                  </label>
                )}
                {cloneSourceVoiceMode === 'elevenlabs' && (
                  <label className="live-translate-setting-tip" data-tip="Real ElevenLabs clone path. Speech-to-speech uses target audio; transcript TTS uses output transcript.">
                    <span>ElevenLabs mode</span>
                    <select disabled={settingsLocked} onChange={(event) => setElevenLabsCloneMode(event.target.value as ElevenLabsCloneMode)} value={elevenLabsCloneMode}>
                      {ELEVENLABS_CLONE_MODE_OPTIONS.map((mode) => (
                        <option key={mode} value={mode}>{elevenLabsCloneModeLabel(mode)}</option>
                      ))}
                    </select>
                  </label>
                )}
                {cloneSourceVoiceMode === 'elevenlabs' && (
                  <label className="live-translate-setting-tip" data-tip="Saved ElevenLabs voice profiles from console settings. Selecting one fills voice_id with the stored value.">
                    <span>saved voice</span>
                    <select
                      disabled={settingsLocked || elevenLabsVoiceProfiles.length === 0}
                      onChange={(event) => {
                        const profile = elevenLabsVoiceProfiles.find((item) => item.email === event.target.value);
                        if (profile) applyElevenLabsVoiceProfile(profile);
                      }}
                      value={selectedElevenLabsVoiceProfile?.email || ''}
                    >
                      <option value="">{elevenLabsVoiceProfiles.length ? 'Select saved email' : 'No saved voices'}</option>
                      {elevenLabsVoiceProfiles.map((profile) => (
                        <option key={profile.email} value={profile.email}>{profile.email}</option>
                      ))}
                    </select>
                  </label>
                )}
                {cloneSourceVoiceMode === 'elevenlabs' && (
                  <label className="live-translate-setting-tip" data-tip="Email is used as the stable label/name for this speaker voice_id. It is saved in console settings.">
                    <span>speaker email</span>
                    <input disabled={settingsLocked} onChange={(event) => setElevenLabsVoiceEmail(normalizeEmail(event.target.value))} placeholder="speaker@example.com" type="email" value={elevenLabsVoiceEmail} />
                  </label>
                )}
                {cloneSourceVoiceMode === 'elevenlabs' && (
                  <label className="live-translate-setting-tip" data-tip="Paste the approved ElevenLabs voice_id. API key stays backend-side in ELEVENLABS_API_KEY.">
                    <span>voice_id</span>
                    <input disabled={settingsLocked} onChange={(event) => setCloneVoiceAlias(event.target.value)} placeholder="ElevenLabs voice_id" type="text" value={cloneVoiceAlias} />
                  </label>
                )}
                <label className="live-translate-setting-tip" data-tip="Consent/version marker for audit. Keep empty if consent is already managed outside this console.">
                  <span>Consent</span>
                  <input disabled={settingsLocked} onChange={(event) => setCloneConsentVersion(event.target.value)} placeholder="voice-consent-v1" type="text" value={cloneConsentVersion} />
                </label>
                <label className="live-translate-setting-tip" data-tip="When provider execution is added, save cloned target audio next to source and Gemini target audio.">
                  <input checked={cloneSaveAudio} disabled={settingsLocked} onChange={(event) => setCloneSaveAudio(event.target.checked)} type="checkbox" />
                  <span>Save clone audio</span>
                </label>
                <label className="live-translate-setting-tip" data-tip="When provider execution is added, keep current Live Translate audio if clone generation fails.">
                  <input checked={cloneFallbackToLiveTranslate} disabled={settingsLocked} onChange={(event) => setCloneFallbackToLiveTranslate(event.target.checked)} type="checkbox" />
                  <span>Fallback audio</span>
                </label>
                {cloneSourceVoiceMode === 'elevenlabs' && (
                  <button
                    className="console-secondary-button live-translate-clone-action"
                    disabled={settingsLocked || voiceProfileCreating || !currentSavedSessionId || !elevenLabsVoiceEmail.trim() || !cloneConsentVersion.trim()}
                    onClick={() => void createElevenLabsVoiceProfileFromSession()}
                    type="button"
                  >
                    {voiceProfileCreating && <Loader2 className="live-translate-spinner" size={14} />}
                    Create voice_id
                  </button>
                )}
                {cloneSourceVoiceMode === 'elevenlabs' && (
                  <button
                    className="console-secondary-button live-translate-clone-action"
                    disabled={settingsLocked || !elevenLabsVoiceEmail.trim() || !cloneVoiceAlias.trim()}
                    onClick={saveCurrentElevenLabsVoiceProfile}
                    type="button"
                  >
                    Save voice_id
                  </button>
                )}
              </div>
              {cloneSourceVoiceMode === 'elevenlabs' && voiceProfileStatus !== 'idle' && (
                <small className="live-translate-clone-note">Voice profile: {voiceProfileStatus}</small>
              )}
              <small className="live-translate-clone-note">
                Google uses backend GOOGLE_TTS_VOICE_CLONING_KEY only. ElevenLabs uses backend ELEVENLABS_API_KEY plus the selected email/voice_id saved in console settings; consent is stored as an audit marker and must reflect real speaker permission.
              </small>
            </>
          )}
        </div>
        <div className={`live-translate-clone-panel ${liveConvGuardEnabled ? 'active' : 'off'}`}>
          <div className="live-translate-clone-head">
            <div>
              <strong>Live Conversation kill switch</strong>
              <span>
                {liveConvGuardEnabled === null
                  ? 'Reading current state from config_domain_registry…'
                  : liveConvGuardEnabled
                    ? 'ON — Collabra app users can start Live Conversation sessions.'
                    : 'OFF — new app sessions are blocked instantly (users see a clear English message).'}
              </span>
            </div>
            <span>{liveConvGuardUpdatedAt ? `Updated: ${liveConvGuardUpdatedAt}` : ''}</span>
          </div>
          <div className="live-translate-profile-row">
            <label className="live-translate-setting-tip" data-tip="Emergency kill switch for the in-app Live Conversation feature. It flips live_conversation_guard.enabled in the database — no deploy or code change needed, safe to toggle anytime. OFF: token issuing stops immediately for all app users; sessions already running end within minutes when their token expires; no data is lost. ON: the feature is restored instantly. Every change (who, when, before/after, errors) is written to the guard log and appears in frontend_log.json and backend_log.json of saved sessions.">
              <span>Kill switch</span>
            </label>
            <button
              className="console-secondary-button"
              disabled={liveConvGuardBusy || liveConvGuardEnabled === null}
              onClick={() => void toggleLiveConversationGuard()}
              type="button"
            >
              {liveConvGuardBusy ? 'Applying…' : liveConvGuardEnabled ? 'Turn OFF (block new sessions)' : 'Turn ON (allow sessions)'}
            </button>
            <button
              className="console-secondary-button"
              disabled={liveConvGuardBusy}
              onClick={() => void refreshLiveConversationGuard('manual_refresh')}
              type="button"
            >
              Refresh
            </button>
            {liveConvGuardNotice && (
              <small className={`live-translate-profile-notice live-translate-profile-notice-${liveConvGuardNoticeTone}`}>
                {liveConvGuardNotice}
              </small>
            )}
          </div>
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
          {waitIndicator.tone !== 'danger' && <Loader2 className="live-translate-spinner" size={18} />}
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
        <span>Clone: {cloneModeLabel(cloneSourceVoiceMode)} / {activeCloneProviderMode}</span>
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
        <span>Clone estimate: {cloneSourceVoiceMode === 'none' ? '$0.000000' : cloneExecutionRecord?.status === 'completed' ? 'provider billed externally' : 'provider guarded until Run clone'}</span>
        <small>
          Paid tier: input ${LIVE_TRANSLATE_PRICING.inputPerMillionTokensUsd}/1M or ${LIVE_TRANSLATE_PRICING.inputPerMinuteUsd}/min; output ${LIVE_TRANSLATE_PRICING.outputPerMillionTokensUsd}/1M or ${LIVE_TRANSLATE_PRICING.outputPerMinuteUsd}/min.
          Clone provider cost is kept separate; Run clone stores provider result and guard status in clone_result.json.
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
              <label>
                <span>Cloned audio</span>
                {targetClonedAudioSrc ? <audio controls src={targetClonedAudioSrc} /> : <small>not saved</small>}
              </label>
            </div>
            <JsonPanel title="session.json" value={sessionDetail.session} />
            <JsonPanel title="input_transcript.json" value={sessionDetail.input_transcript} />
            <JsonPanel title="output_transcript.json" value={sessionDetail.output_transcript} />
            <JsonPanel title="clone_plan.json" value={sessionDetail.clone_plan} />
            <JsonPanel title="clone_result.json" value={sessionDetail.clone_result} />
            <JsonPanel title="voice_profile_result.json" value={sessionDetail.voice_profile_result} />
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
