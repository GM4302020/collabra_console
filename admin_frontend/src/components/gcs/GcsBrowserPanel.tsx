// FILE: ~/otmega/otmega_app/console/admin_frontend/src/components/gcs/GcsBrowserPanel.tsx
// ماموریت: پنل مرور فایل‌های GCS با breadcrumb، پخش صدا و نمایش تصویر.

import {
  ChevronRight,
  File,
  FileAudio,
  FileImage,
  Folder,
  Home,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  browseGcsBucket,
  getGcsAudioContext,
  getGcsSignedUrl,
  getModelPrefs,
  getSvlipLipConfig,
  requestTranscript,
  requestLipTranslation,
  setModelPref,
  setSvlipLipConfig,
  type GcsAudioContextResponse,
  type GcsAudioContextUser,
  type GcsBrowseFile,
  type GcsBrowseFolder,
  type SvlipLipConfig,
} from '../../api/consoleApi';

const LLM_OPTIONS = [
  { key: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  { key: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  { key: 'groq-whisper-turbo', label: 'Groq Whisper Turbo' },
  { key: 'groq-whisper', label: 'Groq Whisper Large' },
  { key: 'gpt-audio', label: 'GPT-Audio 1.5' },
  // { key: 'mai-transcribe', label: 'MAI Transcribe 1.5' },  // فعال‌سازی پس از ست کردن AZURE_SPEECH_KEY
] as const;

const TRANSCRIPT_RUNTIME_ADVICE = {
  currentTimeoutSeconds: 30,
  recommendedTimeoutSeconds: 150,
  recommendedMemory: '1Gi',
};

const LANG_NAMES: Record<string, string> = {
  // اروپای غربی
  en: 'English', de: 'Deutsch', fr: 'Français', es: 'Español', it: 'Italiano',
  pt: 'Português', nl: 'Nederlands', sv: 'Svenska', da: 'Dansk', nb: 'Norsk Bokmål',
  no: 'Norsk', fi: 'Suomi', is: 'Íslenska', ga: 'Gaeilge', cy: 'Cymraeg',
  eu: 'Euskara', ca: 'Català', gl: 'Galego',
  // اروپای مرکزی و شرقی
  pl: 'Polski', cs: 'Čeština', sk: 'Slovenčina', ro: 'Română', hu: 'Magyar',
  hr: 'Hrvatski', bs: 'Bosanski', sr: 'Српски', sl: 'Slovenščina', bg: 'Български',
  mk: 'Македонски', sq: 'Shqip', el: 'Ελληνικά', lt: 'Lietuvių', lv: 'Latviešu',
  et: 'Eesti', uk: 'Українська', ru: 'Русский', be: 'Беларуская',
  // خاورمیانه و آسیای مرکزی
  fa: 'فارسی', ar: 'العربية', tr: 'Türkçe', he: 'עברית', ur: 'اردو',
  az: 'Azərbaycan', ky: 'Кыргызча', uz: 'Oʻzbek', kk: 'Қазақша', ku: 'Kurdî',
  // آسیای جنوبی
  hi: 'हिन्दी', bn: 'বাংলা', gu: 'ગુજરાતી', pa: 'ਪੰਜਾਬੀ', mr: 'मराठी',
  ne: 'नेपाली', ta: 'தமிழ்', te: 'తెలుగు', kn: 'ಕನ್ನಡ', ml: 'മലയാളം',
  si: 'සිංහල',
  // آسیای شرقی و جنوب‌شرقی
  ja: '日本語', ko: '한국어', zh: '中文', vi: 'Tiếng Việt', th: 'ภาษาไทย',
  id: 'Indonesia', ms: 'Melayu', my: 'မြန်မာ',
  // قفقاز
  ka: 'ქართული', hy: 'Հայերեն',
  // آفریقا
  sw: 'Kiswahili', yo: 'Yorùbá', af: 'Afrikaans',
  // مالت
  mt: 'Malti',
};

type MediaState =
  | { kind: 'idle' }
  | { kind: 'loading'; path: string }
  | { kind: 'audio'; path: string; url: string; mimeType: string }
  | { kind: 'image'; path: string; url: string }
  | { kind: 'error'; path: string; message: string };

type AudioContextState =
  | { kind: 'idle' }
  | { kind: 'loading'; path: string }
  | { kind: 'loaded'; path: string; data: GcsAudioContextResponse }
  | { kind: 'error'; path: string; message: string };

type TranscriptResult = {
  llmKey: string;
  llmDisplayName: string;
  detectedLanguage: string;
  transcript: string;
  phoneticIpa: string | null;
  ipaSupported: boolean;
  tone: string | null;
  speakingRate: string | null;
  speakerGender: string | null;
  audioQuality: string | null;
  backgroundNoise: string | null;
  speakerCount: number | null;
  confidence: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostUsd: number | null;
  latencyMs: number;
};

type LipTranslationResult = {
  llmKey: string;
  llmDisplayName: string;
  fallbackFromModelKey: string | null;
  sourceLang: string;
  targetLang: string;
  translatedText: string;
  pivotText: string | null;
  latencyMs: number;
  persisted: boolean;
};

function shouldShowTranscriptRuntimeAdvice(message: string | null): boolean {
  if (!message) return false;
  const normalized = message.toLowerCase();
  return (
    normalized.includes('/api/console/gcs/transcribe failed with 500') ||
    normalized.includes('worker timeout') ||
    normalized.includes('timed out') ||
    normalized.includes('timeout') ||
    normalized.includes('503')
  );
}

function languageLabel(code: string | null | undefined): string {
  if (!code) return 'Unknown';
  const normalized = code.toLowerCase();
  const name = LANG_NAMES[normalized];
  return name ? `${normalized.toUpperCase()} ${name}` : normalized.toUpperCase();
}

function userLabel(user: GcsAudioContextUser | undefined): string {
  if (!user) return 'Unknown user';
  return user.full_name || user.email || user.user_id;
}

function userSubLabel(user: GcsAudioContextUser | undefined): string {
  if (!user) return '';
  if (user.full_name && user.email) return user.email;
  return user.role || user.country_code || '';
}

function languageSourceLabel(source: string | null | undefined): string {
  if (!source) return 'no language source';
  if (source === 'messages.src_lang') return 'message src_lang';
  if (source === 'messages.text_translations.keys') return 'translation history';
  if (source.includes('last_typed_lang_current')) return 'current profile fallback';
  if (source.startsWith('metadata.')) return 'message metadata';
  return source;
}

function firstContextTargetLang(context: AudioContextState): string {
  if (context.kind !== 'loaded' || context.data.status !== 'ok') return '';
  const target = (context.data.recipients || []).find((recipient) => recipient.language);
  return target?.language || '';
}

function buildBreadcrumbs(prefix: string): Array<{ label: string; prefix: string }> {
  const crumbs: Array<{ label: string; prefix: string }> = [{ label: 'root', prefix: '' }];
  if (!prefix) return crumbs;
  const parts = prefix.split('/').filter(Boolean);
  let accumulated = '';
  for (const part of parts) {
    accumulated += `${part}/`;
    crumbs.push({ label: part, prefix: accumulated });
  }
  return crumbs;
}

export default function GcsBrowserPanel() {
  const [prefix, setPrefix] = useState('');
  const [folders, setFolders] = useState<GcsBrowseFolder[]>([]);
  const [files, setFiles] = useState<GcsBrowseFile[]>([]);
  const [nextPageToken, setNextPageToken] = useState<string | null>(null);
  const [bucket, setBucket] = useState('');
  const [loading, setLoading] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [media, setMedia] = useState<MediaState>({ kind: 'idle' });
  const [audioContext, setAudioContext] = useState<AudioContextState>({ kind: 'idle' });

  // transcript state — array so multiple LLM results stack
  const [selectedLlm, setSelectedLlm] = useState<string>('gemini-2.5-flash');
  const [transcriptResults, setTranscriptResults] = useState<TranscriptResult[]>([]);
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const [lipResults, setLipResults] = useState<Record<number, LipTranslationResult>>({});
  const [lipLoadingIndex, setLipLoadingIndex] = useState<number | null>(null);
  const [lipErrors, setLipErrors] = useState<Record<number, string>>({});
  const [lipConfig, setLipConfig] = useState<SvlipLipConfig | null>(null);
  const [selectedLipModel, setSelectedLipModel] = useState('wf1-runtime');
  const [targetLangOverride, setTargetLangOverride] = useState('');
  const [audioDuration, setAudioDuration] = useState<number | null>(null);
  const [modelPrefs, setModelPrefs] = useState<Record<string, string>>({});
  const [prefsLoading, setPrefsLoading] = useState(false);
  const [lastDetectedLanguage, setLastDetectedLanguage] = useState<string | null>(null);
  const [showAllLangs, setShowAllLangs] = useState(false);
  const [autoSelect, setAutoSelect] = useState<boolean>(() =>
    localStorage.getItem('svlip_auto_select') === 'true'
  );

  const audioRef = useRef<HTMLAudioElement>(null);

  // Load prefs from GCS on mount
  useEffect(() => {
    setPrefsLoading(true);
    getModelPrefs()
      .then((r) => setModelPrefs(r.prefs))
      .catch(() => {/* silent — prefs optional */})
      .finally(() => setPrefsLoading(false));
    getSvlipLipConfig()
      .then((r) => {
        setLipConfig(r.config);
        setSelectedLipModel(r.config.active_model_key || 'wf1-runtime');
      })
      .catch(() => {/* silent — LIP config falls back in backend */});
  }, []);

  useEffect(() => {
    const contextTarget = firstContextTargetLang(audioContext);
    if (contextTarget && !targetLangOverride) {
      setTargetLangOverride(contextTarget);
    }
  }, [audioContext, targetLangOverride]);

  // Auto-select: after a new result arrives, switch dropdown to preferred model for detected language
  useEffect(() => {
    if (!autoSelect || transcriptResults.length === 0) return;
    const last = transcriptResults[transcriptResults.length - 1];
    setLastDetectedLanguage(last.detectedLanguage);
    const preferred = modelPrefs[last.detectedLanguage];
    if (preferred && preferred !== selectedLlm) setSelectedLlm(preferred);
  }, [transcriptResults]); // eslint-disable-line react-hooks/exhaustive-deps

  function markBestForLanguage(lang: string, modelKey: string) {
    const updated = { ...modelPrefs, [lang]: modelKey };
    setModelPrefs(updated);
    if (autoSelect) setSelectedLlm(modelKey);
    void setModelPref(lang, modelKey);
  }

  function clearLangPref(lang: string) {
    const updated = { ...modelPrefs };
    delete updated[lang];
    setModelPrefs(updated);
    void setModelPref(lang, null);
  }

  function toggleAutoSelect() {
    const next = !autoSelect;
    setAutoSelect(next);
    localStorage.setItem('svlip_auto_select', String(next));
  }

  function clearTranscript() {
    setTranscriptResults([]);
    setTranscriptError(null);
    setTranscriptLoading(false);
    setLipResults({});
    setLipErrors({});
    setLipLoadingIndex(null);
    setAudioDuration(null);
  }

  function clearAudioContext() {
    setAudioContext({ kind: 'idle' });
    setTargetLangOverride('');
  }

  function handleLipModelChange(modelKey: string) {
    setSelectedLipModel(modelKey);
    void setSvlipLipConfig(modelKey)
      .then((r) => setLipConfig(r.config))
      .catch(() => {/* model still usable for this session */});
  }

  const loadPrefix = useCallback(async (nextPrefix: string, pageToken?: string) => {
    setLoading(true);
    setBrowseError(null);
    if (!pageToken) {
      setFolders([]);
      setFiles([]);
      setNextPageToken(null);
    }
    try {
      const response = await browseGcsBucket({ prefix: nextPrefix, page_token: pageToken });
      setBucket(response.bucket);
      setFolders((current) => (pageToken ? [...current, ...response.folders] : response.folders));
      setFiles((current) => (pageToken ? [...current, ...response.files] : response.files));
      setNextPageToken(response.next_page_token);
      setPrefix(nextPrefix);
    } catch (error) {
      setBrowseError(error instanceof Error ? error.message : 'GCS browse failed.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPrefix('');
  }, [loadPrefix]);

  async function handleFileClick(file: GcsBrowseFile) {
    if (!file.is_audio && !file.is_image) return;
    if (media.kind !== 'idle' && media.kind !== 'error' && (media as { path: string }).path === file.name) {
      setMedia({ kind: 'idle' });
      clearAudioContext();
      return;
    }
    setMedia({ kind: 'loading', path: file.name });
    clearTranscript();
    if (file.is_audio) {
      setAudioContext({ kind: 'loading', path: file.name });
    } else {
      clearAudioContext();
    }
    try {
      const [response, context] = await Promise.all([
        getGcsSignedUrl(file.name),
        file.is_audio ? getGcsAudioContext(file.name).catch((error) => error as Error) : Promise.resolve(null),
      ]);
      if (file.is_audio) {
        setMedia({ kind: 'audio', path: file.name, url: response.signed_url, mimeType: file.content_type || 'audio/mp3' });
        if (context instanceof Error) {
          setAudioContext({ kind: 'error', path: file.name, message: context.message || 'Audio context lookup failed.' });
        } else if (context) {
          setAudioContext({ kind: 'loaded', path: file.name, data: context });
        }
      } else {
        setMedia({ kind: 'image', path: file.name, url: response.signed_url });
      }
    } catch (error) {
      clearAudioContext();
      setMedia({
        kind: 'error',
        path: file.name,
        message: error instanceof Error ? error.message : 'Failed to get signed URL.',
      });
    }
  }

  function handleFolderClick(folder: GcsBrowseFolder) {
    if (media.kind === 'audio' || media.kind === 'image') {
      setMedia({ kind: 'idle' });
      clearTranscript();
      clearAudioContext();
    }
    void loadPrefix(folder.prefix);
  }

  function handleBreadcrumbClick(crumbPrefix: string) {
    if (crumbPrefix === prefix) return;
    if (media.kind === 'audio' || media.kind === 'image') {
      setMedia({ kind: 'idle' });
      clearTranscript();
      clearAudioContext();
    }
    void loadPrefix(crumbPrefix);
  }

  async function handleTranscript() {
    if (media.kind !== 'audio') return;
    setTranscriptLoading(true);
    setTranscriptError(null);
    const t0 = performance.now();
    try {
      const result = await requestTranscript(media.path, media.mimeType, selectedLlm);
      const latencyMs = Math.round(performance.now() - t0);
      const d = result.data;
      const newResult: TranscriptResult = {
        llmKey: d.model_key,
        llmDisplayName: d.model_display_name,
        detectedLanguage: d.detected_language,
        transcript: d.transcript,
        phoneticIpa: d.phonetic_ipa,
        ipaSupported: d.ipa_supported,
        tone: d.tone ?? null,
        speakingRate: d.speaking_rate ?? null,
        speakerGender: d.speaker_gender ?? null,
        audioQuality: d.audio_quality ?? null,
        backgroundNoise: d.background_noise ?? null,
        speakerCount: d.speaker_count ?? null,
        confidence: d.confidence ?? null,
        inputTokens: d.input_tokens ?? null,
        outputTokens: d.output_tokens ?? null,
        estimatedCostUsd: d.estimated_cost_usd ?? null,
        latencyMs,
      };
      setTranscriptResults((prev) => [...prev, newResult]);
      setLastDetectedLanguage(newResult.detectedLanguage);
    } catch (error) {
      setTranscriptError(error instanceof Error ? error.message : 'Transcript request failed.');
    } finally {
      setTranscriptLoading(false);
    }
  }

  async function handleLipTranslate(result: TranscriptResult, index: number) {
    const targetLang = (targetLangOverride || firstContextTargetLang(audioContext)).trim().toLowerCase();
    if (!targetLang) {
      setLipErrors((prev) => ({ ...prev, [index]: 'Target language is missing. Select a destination language first.' }));
      return;
    }
    setLipLoadingIndex(index);
    setLipErrors((prev) => {
      const updated = { ...prev };
      delete updated[index];
      return updated;
    });
    try {
      const response = await requestLipTranslation({
        transcript: result.transcript,
        source_lang: result.detectedLanguage,
        target_lang: targetLang,
        model_key: selectedLipModel,
      });
      const d = response.data;
      setLipResults((prev) => ({
        ...prev,
        [index]: {
          llmKey: d.model_key,
          llmDisplayName: d.model_display_name,
          fallbackFromModelKey: d.fallback_from_model_key ?? null,
          sourceLang: d.source_lang,
          targetLang: d.target_lang,
          translatedText: d.translated_text,
          pivotText: d.pivot_text,
          latencyMs: d.latency_ms,
          persisted: d.persisted,
        },
      }));
    } catch (error) {
      setLipErrors((prev) => ({
        ...prev,
        [index]: error instanceof Error ? error.message : 'LIP translation failed.',
      }));
    } finally {
      setLipLoadingIndex(null);
    }
  }

  const breadcrumbs = buildBreadcrumbs(prefix);
  const selectedPath = media.kind !== 'idle' ? (media as { path: string }).path : null;

  return (
    <div className="gcs-browser">
      <div className="gcs-browser-toolbar">
        <nav aria-label="GCS folder path" className="gcs-breadcrumb">
          {breadcrumbs.map((crumb, index) => (
            <span key={crumb.prefix} className="gcs-breadcrumb-item">
              {index > 0 && <ChevronRight aria-hidden="true" size={14} />}
              {index === 0 ? (
                <button onClick={() => handleBreadcrumbClick('')} title="Bucket root" type="button">
                  <Home aria-hidden="true" size={14} />
                  <span>{bucket || 'bucket'}</span>
                </button>
              ) : (
                <button
                  className={crumb.prefix === prefix ? 'active' : ''}
                  onClick={() => handleBreadcrumbClick(crumb.prefix)}
                  type="button"
                >
                  {crumb.label}
                </button>
              )}
            </span>
          ))}
        </nav>
        <button
          className="console-secondary-button"
          disabled={loading}
          onClick={() => loadPrefix(prefix)}
          title="Refresh"
          type="button"
        >
          {loading ? <Loader2 aria-hidden="true" className="spin" size={15} /> : <RefreshCw aria-hidden="true" size={15} />}
        </button>
      </div>

      {browseError ? <div className="console-alert error">{browseError}</div> : null}

      <div className="gcs-browser-list">
        {folders.length === 0 && files.length === 0 && !loading ? (
          <p className="gcs-browser-empty">This folder is empty.</p>
        ) : null}

        {folders.map((folder) => (
          <button
            className="gcs-browser-item gcs-folder"
            key={folder.prefix}
            onClick={() => handleFolderClick(folder)}
            type="button"
          >
            <Folder aria-hidden="true" size={17} />
            <span>{folder.short_name || folder.prefix}</span>
          </button>
        ))}

        {files.map((file) => {
          const isSelected = selectedPath === file.name;
          const isLoadingThis = media.kind === 'loading' && media.path === file.name;
          const clickable = file.is_audio || file.is_image;
          const Icon = file.is_audio ? FileAudio : file.is_image ? FileImage : File;
          return (
            <button
              aria-pressed={isSelected}
              className={`gcs-browser-item gcs-file ${isSelected ? 'selected' : ''} ${!clickable ? 'disabled' : ''}`}
              disabled={!clickable}
              key={file.name}
              onClick={() => handleFileClick(file)}
              title={file.name}
              type="button"
            >
              {isLoadingThis ? (
                <Loader2 aria-hidden="true" className="spin" size={17} />
              ) : (
                <Icon aria-hidden="true" size={17} />
              )}
              <span className="gcs-file-name">{file.short_name}</span>
              <small className="gcs-file-meta">{file.size_label}</small>
            </button>
          );
        })}
      </div>

      {nextPageToken ? (
        <div className="gcs-browser-more">
          <button
            className="console-secondary-button"
            disabled={loading}
            onClick={() => loadPrefix(prefix, nextPageToken)}
            type="button"
          >
            {loading ? <Loader2 aria-hidden="true" className="spin" size={15} /> : null}
            Load more
          </button>
        </div>
      ) : null}

      {media.kind === 'audio' ? (
        <div className="gcs-media-player">
          <p className="gcs-media-label">{media.path.split('/').pop()}</p>
          <audio
            autoPlay
            controls
            key={media.url}
            onDurationChange={() => {
              if (audioRef.current && isFinite(audioRef.current.duration) && audioRef.current.duration > 0) {
                setAudioDuration(audioRef.current.duration);
              }
            }}
            onLoadedMetadata={() => {
              if (audioRef.current && isFinite(audioRef.current.duration) && audioRef.current.duration > 0) {
                setAudioDuration(audioRef.current.duration);
              }
            }}
            ref={audioRef}
            src={media.url}
            style={{ width: '100%' }}
          />
          {audioContext.kind === 'loading' ? (
            <div className="gcs-audio-context-panel muted">
              <Loader2 aria-hidden="true" className="spin" size={14} />
              <span>Loading conversation context</span>
            </div>
          ) : audioContext.kind === 'error' ? (
            <div className="gcs-audio-context-panel error">
              <strong>Conversation context unavailable</strong>
              <span>{audioContext.message}</span>
            </div>
          ) : audioContext.kind === 'loaded' && audioContext.data.status === 'not_found' ? (
            <div className="gcs-audio-context-panel muted">
              <strong>Conversation context not found</strong>
              <span>{audioContext.data.message || 'No message record matched this audio file path.'}</span>
            </div>
          ) : audioContext.kind === 'loaded' && audioContext.data.status === 'ok' ? (
            <div className="gcs-audio-context-panel">
              <div className="gcs-audio-context-header">
                <strong>Conversation context</strong>
                <span>{audioContext.data.conversation?.id || 'unknown conversation'}</span>
                {audioContext.data.message_record?.id ? <span>message {audioContext.data.message_record.id}</span> : null}
              </div>
              <div className="gcs-audio-context-grid">
                <div className="gcs-audio-context-card source">
                  <small>Source voice</small>
                  <strong>{languageLabel(audioContext.data.sender?.language)}</strong>
                  <span>{userLabel(audioContext.data.sender)}</span>
                  <em>{userSubLabel(audioContext.data.sender)}</em>
                  <b>{languageSourceLabel(audioContext.data.sender?.language_source)}</b>
                </div>
                {(audioContext.data.recipients || []).map((recipient) => (
                  <div className="gcs-audio-context-card" key={recipient.user_id}>
                    <small>Destination</small>
                    <strong>{languageLabel(recipient.language)}</strong>
                    <span>{userLabel(recipient)}</span>
                    <em>{userSubLabel(recipient)}</em>
                    <b>{languageSourceLabel(recipient.language_source)}</b>
                  </div>
                ))}
              </div>
              {!audioContext.data.language_summary?.historical_destination_available ? (
                <p className="gcs-audio-context-note">
                  Destination language is from the recipient profile unless message metadata has historical language data.
                </p>
              ) : null}
            </div>
          ) : null}
          <div className="gcs-transcript-actions">
            <select
              className="gcs-transcript-llm-select"
              onChange={(e) => setSelectedLlm(e.target.value)}
              value={selectedLlm}
            >
              {LLM_OPTIONS.map((opt) => {
                const isPreferred = lastDetectedLanguage != null && modelPrefs[lastDetectedLanguage] === opt.key;
                return (
                  <option key={opt.key} value={opt.key}>
                    {isPreferred ? `★ ${opt.label}` : opt.label}
                  </option>
                );
              })}
            </select>
            <button
              className="console-secondary-button"
              disabled={transcriptLoading}
              onClick={() => void handleTranscript()}
              type="button"
            >
              {transcriptLoading ? <Loader2 aria-hidden="true" className="spin" size={15} /> : null}
              Get Transcript
            </button>
            <button
              className={`gcs-transcript-auto-btn${autoSelect ? ' active' : ''}`}
              onClick={toggleAutoSelect}
              title="Auto-select best model per detected language"
              type="button"
            >
              Auto
            </button>
          </div>

          {/* ── Supported Languages ── */}
          <div className="gcs-supported-langs">
            <span className="gcs-supported-langs-label">
              {Object.keys(LANG_NAMES).length} supported languages:
            </span>
            {Object.entries(LANG_NAMES).map(([code, name], i, arr) => (
              <span key={code} className="gcs-supported-lang-item">
                <span className="gcs-supported-lang-code">{code.toUpperCase()}</span>
                {' '}{name}{i < arr.length - 1 ? ' · ' : ''}
              </span>
            ))}
          </div>

          {/* ── Language Preferences Panel ── */}
          {(Object.keys(modelPrefs).length > 0 || showAllLangs) && (
            <div className="gcs-lang-prefs-panel">
              <div className="gcs-lang-prefs-header">
                <span className="gcs-lang-prefs-title">
                  {prefsLoading ? <Loader2 aria-hidden="true" className="spin" size={12} /> : '★'} Language Preferences
                </span>
                <button
                  className="gcs-lang-prefs-toggle"
                  onClick={() => setShowAllLangs((v) => !v)}
                  type="button"
                >
                  {showAllLangs ? 'show set only' : `show all ${Object.keys(LANG_NAMES).length}`}
                </button>
              </div>
              <div className="gcs-lang-prefs-grid">
                {Object.entries(LANG_NAMES)
                  .filter(([code]) => showAllLangs || modelPrefs[code])
                  .map(([code, name]) => {
                    const preferred = modelPrefs[code];
                    const prefLabel = preferred
                      ? (LLM_OPTIONS.find((o) => o.key === preferred)?.label ?? preferred)
                      : null;
                    return (
                      <div key={code} className={`gcs-lang-pref-row${preferred ? ' has-pref' : ''}`}>
                        <span className="gcs-lang-pref-code">{code.toUpperCase()}</span>
                        <span className="gcs-lang-pref-name">{name}</span>
                        {prefLabel ? (
                          <>
                            <span className="gcs-lang-pref-model">★ {prefLabel}</span>
                            <button
                              className="gcs-lang-pref-clear"
                              onClick={() => clearLangPref(code)}
                              title={`Clear preference for ${name}`}
                              type="button"
                            >✕</button>
                          </>
                        ) : (
                          <span className="gcs-lang-pref-model empty">—</span>
                        )}
                      </div>
                    );
                  })}
              </div>
            </div>
          )}
          {Object.keys(modelPrefs).length === 0 && !showAllLangs && (
            <button
              className="gcs-lang-prefs-show-btn"
              onClick={() => setShowAllLangs(true)}
              type="button"
            >
              ★ View language preferences
            </button>
          )}

          {transcriptResults.map((result, index) => (
            <div key={index}>
              {index > 0 && <hr className="gcs-transcript-separator" />}
              <div className="gcs-transcript-result">
                <div className="gcs-transcript-result-header">
                  <span className="gcs-transcript-llm-name">{result.llmDisplayName}</span>
                  <div className="gcs-transcript-badges">
                    <span className="gcs-transcript-lang-badge">{result.detectedLanguage}</span>
                    <button
                      className={`gcs-transcript-mark-btn${modelPrefs[result.detectedLanguage] === result.llmKey ? ' marked' : ''}`}
                      onClick={() => markBestForLanguage(result.detectedLanguage, result.llmKey)}
                      title={`Mark ${result.llmDisplayName} as best for ${result.detectedLanguage.toUpperCase()}`}
                      type="button"
                    >
                      {modelPrefs[result.detectedLanguage] === result.llmKey ? '★' : '☆'} best for {result.detectedLanguage.toUpperCase()}
                    </button>
                    {result.confidence ? <span className="gcs-transcript-badge">{result.confidence}</span> : null}
                    {result.tone ? <span className="gcs-transcript-badge">{result.tone}</span> : null}
                    {result.speakingRate ? <span className="gcs-transcript-badge">{result.speakingRate}</span> : null}
                    {result.speakerGender ? <span className="gcs-transcript-badge">{result.speakerGender}</span> : null}
                  </div>
                </div>
                <p className="gcs-transcript-text">{result.transcript}</p>
                {result.phoneticIpa ? (
                  <p className="gcs-transcript-ipa">{result.phoneticIpa}</p>
                ) : !result.ipaSupported ? (
                  <p className="gcs-transcript-ipa" style={{ fontStyle: 'italic' }}>IPA not available for this language</p>
                ) : null}
                <div className="gcs-transcript-meta">
                  {audioDuration != null ? <span>voice: {audioDuration.toFixed(2)}s</span> : null}
                  <span>latency: {(result.latencyMs / 1000).toFixed(2)}s</span>
                  {result.audioQuality ? <span>quality: {result.audioQuality}</span> : null}
                  {result.backgroundNoise ? <span>noise: {result.backgroundNoise}</span> : null}
                  {result.speakerCount != null ? <span>speakers: {result.speakerCount}</span> : null}
                  {result.inputTokens != null ? <span>in: {result.inputTokens.toLocaleString()}t</span> : null}
                  {result.outputTokens != null ? <span>out: {result.outputTokens.toLocaleString()}t</span> : null}
                  {result.estimatedCostUsd != null ? (
                    <span className="gcs-transcript-cost">~${result.estimatedCostUsd.toFixed(4)}</span>
                  ) : null}
                </div>
                <div className="gcs-lip-preview-panel">
                  <div className="gcs-lip-preview-controls">
                    <select
                      className="gcs-transcript-llm-select"
                      onChange={(e) => handleLipModelChange(e.target.value)}
                      value={selectedLipModel}
                    >
                      {(lipConfig?.available_models || [{ key: 'wf1-runtime', label: 'WF1 Runtime LIP' }]).map((opt) => (
                        <option key={opt.key} value={opt.key}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                    <input
                      className="gcs-lip-target-input"
                      maxLength={5}
                      onChange={(e) => setTargetLangOverride(e.target.value.toLowerCase())}
                      placeholder="target"
                      value={targetLangOverride}
                    />
                    <button
                      className="console-secondary-button"
                      disabled={lipLoadingIndex === index}
                      onClick={() => void handleLipTranslate(result, index)}
                      type="button"
                    >
                      {lipLoadingIndex === index ? <Loader2 aria-hidden="true" className="spin" size={15} /> : null}
                      Get LIP
                    </button>
                  </div>
                  <div className="gcs-lip-preview-grid">
                    <div>
                      <small>Transcript source</small>
                      <strong>{languageLabel(result.detectedLanguage)}</strong>
                      <p>{result.transcript}</p>
                    </div>
                    <div>
                      <small>LIP destination</small>
                      <strong>{languageLabel(lipResults[index]?.targetLang || targetLangOverride)}</strong>
                      <p>{lipResults[index]?.translatedText || 'Run LIP to preview the destination-language text.'}</p>
                    </div>
                  </div>
                  {lipResults[index] ? (
                    <div className="gcs-lip-preview-meta">
                      <span>{lipResults[index].llmDisplayName}</span>
                      {lipResults[index].fallbackFromModelKey ? <span>fallback from {lipResults[index].fallbackFromModelKey}</span> : null}
                      <span>latency: {(lipResults[index].latencyMs / 1000).toFixed(2)}s</span>
                      <span>{lipResults[index].persisted ? 'persisted' : 'preview only'}</span>
                    </div>
                  ) : null}
                  {lipErrors[index] ? <div className="console-alert error">{lipErrors[index]}</div> : null}
                </div>
              </div>
            </div>
          ))}

          {transcriptError ? (
            <div className="console-alert error">
              {transcriptError}
              {shouldShowTranscriptRuntimeAdvice(transcriptError) ? (
                <div className="gcs-transcript-runtime-advice">
                  <strong>Transcript runtime recommendation</strong>
                  <span>
                    Current worker timeout is probably {TRANSCRIPT_RUNTIME_ADVICE.currentTimeoutSeconds}s on the old
                    revision. Recommended: {TRANSCRIPT_RUNTIME_ADVICE.recommendedTimeoutSeconds}s and backend memory{' '}
                    {TRANSCRIPT_RUNTIME_ADVICE.recommendedMemory}.
                  </span>
                  <span>
                    Apply by deploying `otmega` and `otmega-console` with `GUNICORN_TIMEOUT_SECONDS=150`.
                  </span>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {media.kind === 'image' ? (
        <div className="gcs-media-viewer">
          <p className="gcs-media-label">{media.path.split('/').pop()}</p>
          <img alt={media.path.split('/').pop()} className="gcs-media-image" src={media.url} />
        </div>
      ) : null}

      {media.kind === 'error' ? (
        <div className="console-alert error">
          {media.path.split('/').pop()}: {media.message}
        </div>
      ) : null}
    </div>
  );
}
