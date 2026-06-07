// FILE: ~/otmega/otmega_app/console/admin_frontend/src/components/live-asr/LiveAsrPanel.tsx
// ماموریت: دو حالت با یک دکمه — Live Streaming (ترنسکریپت آنی) و Record (ضبط کامل + ذخیره GCS).
//   • تک‌کلیک = سوئیچ حالت  |  نگه‌داشتن = اجرای عملکرد

import { useEffect, useRef, useState } from 'react';
import {
  AudioWaveform, Captions, KeyboardMusic, Megaphone, Mic, MicVocal,
} from 'lucide-react';
import { sendLiveChunk, uploadAudioToGcs } from '../../api/consoleApi';

// MDI microphone-message — inline SVG (mic on left + speech bubble on right)
function MdiMicrophoneMessage({ size = 24 }: { size?: number; strokeWidth?: number; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor">
      <path d="M8,7A2,2 0 0,1 10,9V14A2,2 0 0,1 8,16A2,2 0 0,1 6,14V9A2,2 0 0,1 8,7M14,14C14,16.97 11.84,19.44 9,19.92V22H7V19.92C4.16,19.44 2,16.97 2,14H4A4,4 0 0,0 8,18A4,4 0 0,0 12,14H14M21.41,9.41L17.17,13.66L18.18,10H14A2,2 0 0,1 12,8V4A2,2 0 0,1 14,2H20A2,2 0 0,1 22,4V8C22,8.55 21.78,9.05 21.41,9.41Z" />
    </svg>
  );
}

// ─── Constants ────────────────────────────────────────────────────────────────

type IconMode = 'live' | 'record';
type Status   = 'idle' | 'live-streaming' | 'live-processing' | 'recording' | 'recorded';
type IconComponent = React.FC<{ size?: number; strokeWidth?: number; className?: string }>;

const HOLD_THRESHOLD_MS = 220;
const CHUNK_MS          = 3000;
const TOOLTIP_DURATION  = 3000;
const GCS_UPLOAD_PREFIX = 'users/9197bacb-2387-4639-814f-9d643bbfb245/uploads';

const WHISPER_MODELS = [
  { key: 'whisper-large-v3-turbo', label: 'Groq Whisper Turbo' },
  { key: 'whisper-large-v3',       label: 'Groq Whisper Large'  },
] as const;

const ICON_OPTIONS: Array<{ id: string; label: string; Icon: IconComponent }> = [
  { id: 'mdi-mic-msg',    label: 'microphone-message', Icon: MdiMicrophoneMessage },
  { id: 'keyboard-music', label: 'keyboard_voice',     Icon: KeyboardMusic        },
  { id: 'audio-waveform', label: 'speech-to-text',     Icon: AudioWaveform        },
  { id: 'mic-vocal',      label: 'mic-vocal',          Icon: MicVocal             },
  { id: 'megaphone',      label: 'speakerphone',        Icon: Megaphone            },
  { id: 'captions',       label: 'mic-transcribe',      Icon: Captions             },
];

const TOOLTIP_TEXT: Record<IconMode, string> = {
  live:   'Hold to stream live transcription',
  record: 'Hold to record · Release to save to GCS',
};

// ─── Segment types (Live mode) ────────────────────────────────────────────────

type ChunkMeta = { latencyMs: number; durationMs: number; costOtcoin: number; costUsd: number; model: string };
type Segment   = { id: number; lang: string; text: string; chunks: ChunkMeta[]; startedAt: Date };

function fmtTime(d: Date)               { return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
function avgMs(chunks: ChunkMeta[])     { return chunks.length ? Math.round(chunks.reduce((s, c) => s + c.latencyMs, 0) / chunks.length) : 0; }
function totalCost(chunks: ChunkMeta[]) { return chunks.reduce((s, c) => s + c.costOtcoin, 0); }
function fmtDuration(sec: number)       { return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; }

// ─── Component ────────────────────────────────────────────────────────────────

export default function LiveAsrPanel() {
  // ── general
  const [status,       setStatus]       = useState<Status>('idle');
  const [whisperModel, setWhisperModel] = useState<string>('whisper-large-v3');
  const [elapsed,      setElapsed]      = useState(0);
  const [error,        setError]        = useState<string | null>(null);

  // ── icon mode per button
  const [iconModes,     setIconModes]     = useState<Record<string, IconMode>>({});
  const [tooltipIconId, setTooltipIconId] = useState<string | null>(null);

  // ── live streaming state
  const [segments,              setSegments]              = useState<Segment[]>([]);
  const [totalChunks,           setTotalChunks]           = useState(0);
  const [sessionTotalCostOtcoin, setSessionTotalCostOtcoin] = useState(0);

  // ── record mode state
  const [recordedBlob,     setRecordedBlob]     = useState<Blob | null>(null);
  const [recordedDuration, setRecordedDuration] = useState(0);
  const [saveStatus,       setSaveStatus]       = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [savedPath,        setSavedPath]        = useState<string | null>(null);
  const [audioUrl,         setAudioUrl]         = useState<string | null>(null);

  // ── refs
  const streamRef          = useRef<MediaStream | null>(null);
  const isActiveRef        = useRef(false);       // any recording in progress
  const isPttHeldRef       = useRef(false);
  const liveRecorderRef    = useRef<MediaRecorder | null>(null);
  const fullRecorderRef    = useRef<MediaRecorder | null>(null);
  const fullChunksRef      = useRef<Blob[]>([]);
  const timerRef           = useRef<ReturnType<typeof setInterval>  | null>(null);
  const holdTimerRef       = useRef<ReturnType<typeof setTimeout>   | null>(null);
  const tooltipTimerRef    = useRef<ReturnType<typeof setTimeout>   | null>(null);
  const pointerDownAtRef   = useRef<number | null>(null);
  const activeIconIdRef    = useRef<string | null>(null);
  const elapsedRef         = useRef(0);
  const segmentsRef        = useRef<Segment[]>([]);
  const segIdRef           = useRef(0);

  // ── helpers ──────────────────────────────────────────────────────────────────

  function getIconMode(iconId: string): IconMode { return iconModes[iconId] ?? 'live'; }

  function showTooltip(iconId: string) {
    setTooltipIconId(iconId);
    if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current);
    tooltipTimerRef.current = setTimeout(() => setTooltipIconId(null), TOOLTIP_DURATION);
  }

  function toggleIconMode(iconId: string) {
    setIconModes(prev => ({ ...prev, [iconId]: prev[iconId] === 'record' ? 'live' : 'record' }));
    showTooltip(iconId);
  }

  function syncSegments(updated: Segment[]) { segmentsRef.current = updated; setSegments([...updated]); }

  function appendChunk(transcript: string, lang: string, latencyMs: number, durationMs: number, costOtcoin: number, costUsd: number, model: string) {
    const chunk: ChunkMeta = { latencyMs, durationMs, costOtcoin, costUsd, model };
    const segs = segmentsRef.current;
    const last  = segs[segs.length - 1];
    if (last && last.lang === lang) {
      const updated = [...segs];
      updated[updated.length - 1] = { ...last, text: last.text ? `${last.text} ${transcript}` : transcript, chunks: [...last.chunks, chunk] };
      syncSegments(updated);
    } else {
      segIdRef.current += 1;
      syncSegments([...segs, { id: segIdRef.current, lang, text: transcript, chunks: [chunk], startedAt: new Date() }]);
    }
    setTotalChunks(n => n + 1);
    setSessionTotalCostOtcoin(prev => Math.round((prev + costOtcoin) * 10000) / 10000);
  }

  function startTimer() {
    if (timerRef.current) clearInterval(timerRef.current);
    elapsedRef.current = 0; setElapsed(0);
    timerRef.current = setInterval(() => { elapsedRef.current += 1; setElapsed(elapsedRef.current); }, 1000);
  }
  function stopTimer() {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null; setElapsed(0); elapsedRef.current = 0;
  }

  function getMimeType() {
    return MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
         : MediaRecorder.isTypeSupported('audio/webm')             ? 'audio/webm'
         : '';
  }

  async function ensureStream(): Promise<MediaStream | null> {
    if (streamRef.current) return streamRef.current;
    try {
      streamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      return streamRef.current;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Microphone access denied.');
      return null;
    }
  }

  // ── Live streaming ────────────────────────────────────────────────────────────

  function startChunk(stream: MediaStream, model: string) {
    if (!isActiveRef.current) return;
    const mimeType = getMimeType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    liveRecorderRef.current = recorder;
    const chunks: Blob[] = [];

    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    recorder.onstop = async () => {
      const stillActive = isActiveRef.current;
      const blob = new Blob(chunks, { type: mimeType || 'audio/webm' });
      if (blob.size < 500) { if (stillActive) startChunk(stream, model); else setStatus('idle'); return; }
      if (!stillActive) setStatus('live-processing');
      try {
        const result = await sendLiveChunk(blob, model);
        if (result.transcript?.trim()) appendChunk(
          result.transcript.trim(),
          result.language_code || 'unknown',
          result.latency_ms,
          result.duration_ms ?? 0,
          result.estimated_cost_otcoin ?? 0,
          result.estimated_cost_usd ?? 0,
          result.model_key ?? model,
        );
      } catch { /* silent */ }
      if (isActiveRef.current) { setStatus('live-streaming'); startChunk(stream, model); } else setStatus('idle');
    };

    recorder.start();
    setTimeout(() => { if (recorder.state === 'recording') recorder.stop(); }, CHUNK_MS);
  }

  async function startLiveStreaming() {
    const stream = await ensureStream();
    if (!stream) return;
    isPttHeldRef.current = true;
    if (!isActiveRef.current) {
      isActiveRef.current = true;
      setStatus('live-streaming');
      setError(null);
      startTimer();
      startChunk(stream, whisperModel);
    }
  }

  function stopLiveStreaming() {
    isPttHeldRef.current = false;
    if (!isActiveRef.current) return;
    isActiveRef.current = false;
    stopTimer();
    if (liveRecorderRef.current?.state === 'recording') liveRecorderRef.current.stop();
  }

  // ── Full recording ────────────────────────────────────────────────────────────

  async function startFullRecording() {
    const stream = await ensureStream();
    if (!stream) return;
    if (isActiveRef.current) return;

    const mimeType = getMimeType();
    fullChunksRef.current = [];
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    fullRecorderRef.current = recorder;

    recorder.ondataavailable = (e) => { if (e.data.size > 0) fullChunksRef.current.push(e.data); };
    recorder.onstop = () => {
      const blob = new Blob(fullChunksRef.current, { type: mimeType || 'audio/webm' });
      const dur  = elapsedRef.current;
      stopTimer();
      setRecordedDuration(dur);
      setRecordedBlob(blob);
      setSaveStatus('idle');
      setSavedPath(null);
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      setAudioUrl(URL.createObjectURL(blob));
      setStatus('recorded');
      isActiveRef.current = false;
    };

    recorder.start();
    isActiveRef.current = true;
    setStatus('recording');
    setError(null);
    setRecordedBlob(null);
    setSavedPath(null);
    startTimer();
  }

  function stopFullRecording() {
    if (fullRecorderRef.current?.state === 'recording') fullRecorderRef.current.stop();
    // onstop handles state cleanup
  }

  async function handleSaveToGcs() {
    if (!recordedBlob) return;
    setSaveStatus('saving');
    try {
      const ts  = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
      const ext = recordedBlob.type.includes('ogg') ? 'ogg' : recordedBlob.type.includes('wav') ? 'wav' : 'webm';
      const filename = `rec_${ts}.${ext}`;
      const result = await uploadAudioToGcs(recordedBlob, filename, GCS_UPLOAD_PREFIX);
      setSavedPath(result.path);
      setSaveStatus('saved');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed.');
      setSaveStatus('error');
    }
  }

  function discardRecording() {
    setRecordedBlob(null);
    if (audioUrl) { URL.revokeObjectURL(audioUrl); setAudioUrl(null); }
    setSaveStatus('idle');
    setSavedPath(null);
    setStatus('idle');
  }

  // ── Pointer interaction ───────────────────────────────────────────────────────

  function handleIconPointerDown(e: React.PointerEvent, iconId: string) {
    e.preventDefault();
    if (isActiveRef.current || status === 'live-processing') return;
    activeIconIdRef.current = iconId;
    pointerDownAtRef.current = Date.now();

    holdTimerRef.current = setTimeout(() => {
      // Held long enough → execute action
      const mode = getIconMode(iconId);
      setError(null);
      if (mode === 'live') void startLiveStreaming();
      else void startFullRecording();
    }, HOLD_THRESHOLD_MS);
  }

  function handleIconPointerUp(iconId: string) {
    const elapsed = Date.now() - (pointerDownAtRef.current ?? Date.now());
    if (holdTimerRef.current) { clearTimeout(holdTimerRef.current); holdTimerRef.current = null; }

    if (elapsed < HOLD_THRESHOLD_MS) {
      // Quick tap → toggle mode (no action yet)
      toggleIconMode(iconId);
    } else {
      // Was holding → stop action
      const mode = getIconMode(iconId);
      if (mode === 'live') stopLiveStreaming();
      else stopFullRecording();
    }
    activeIconIdRef.current = null;
  }

  function handleIconPointerLeave(iconId: string) {
    if (holdTimerRef.current) { clearTimeout(holdTimerRef.current); holdTimerRef.current = null; }
    if (isActiveRef.current && activeIconIdRef.current === iconId) {
      const mode = getIconMode(iconId);
      if (mode === 'live') stopLiveStreaming();
      else stopFullRecording();
    }
    activeIconIdRef.current = null;
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────────

  useEffect(() => {
    return () => {
      isActiveRef.current = false;
      liveRecorderRef.current?.stop();
      fullRecorderRef.current?.stop();
      streamRef.current?.getTracks().forEach(t => t.stop());
      if (timerRef.current)     clearInterval(timerRef.current);
      if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
      if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current);
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    };
  }, []);

  // ── Derived ──────────────────────────────────────────────────────────────────

  const isLiveActive      = status === 'live-streaming' || status === 'live-processing';
  const isRecordingActive = status === 'recording';
  const isAnyActive       = isLiveActive || isRecordingActive;
  const isProcessing      = status === 'live-processing';

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="live-asr-panel">

      {/* ── Model selector + session stats ── */}
      <div className="live-asr-controls">
        <select
          className="gcs-transcript-llm-select"
          disabled={isAnyActive || isProcessing}
          onChange={(e) => setWhisperModel(e.target.value)}
          value={whisperModel}
        >
          {WHISPER_MODELS.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
        </select>

        {(isAnyActive || totalChunks > 0) && (
          <div className="live-asr-session-stats">
            {(isLiveActive || isRecordingActive) && (
              <><span className={`live-asr-dot ${isRecordingActive ? 'recording-full' : 'recording'}`} /><span>{fmtDuration(elapsed)}</span></>
            )}
            {isProcessing && <><span className="live-asr-dot processing" /><span>Processing…</span></>}
            {totalChunks > 0 && !isRecordingActive && <span>{totalChunks} chunks</span>}
            {sessionTotalCostOtcoin > 0 && <span className="live-asr-session-cost">{sessionTotalCostOtcoin.toFixed(4)} OTC</span>}
          </div>
        )}
      </div>

      {/* ── Icon suggestion buttons ── */}
      <div className="live-asr-icon-suggestions">
        <span className="live-asr-icon-suggestions-label">
          Tap to switch mode · Hold to use
        </span>
        <div className="live-asr-icon-suggestions-row">
          {ICON_OPTIONS.map((opt) => {
            const mode        = getIconMode(opt.id);
            const isThisLive  = isLiveActive  && activeIconIdRef.current === opt.id;
            const isThisRec   = isRecordingActive && activeIconIdRef.current === opt.id;
            const isThisActive = isThisLive || isThisRec;
            const IconToShow  = mode === 'record' ? Mic : opt.Icon;

            return (
              <div key={opt.id} className="live-asr-icon-option">
                <div className="live-asr-icon-tooltip-wrap">
                  <button
                    className={[
                      'live-asr-icon-btn',
                      mode === 'record' ? 'mode-record' : 'mode-live',
                      isThisActive ? 'active' : '',
                    ].filter(Boolean).join(' ')}
                    onPointerDown={(e) => handleIconPointerDown(e, opt.id)}
                    onPointerUp={() => handleIconPointerUp(opt.id)}
                    onPointerLeave={() => handleIconPointerLeave(opt.id)}
                    onPointerCancel={() => handleIconPointerLeave(opt.id)}
                    onContextMenu={(e) => e.preventDefault()}
                    disabled={isAnyActive && activeIconIdRef.current !== opt.id}
                    type="button"
                  >
                    <IconToShow size={22} strokeWidth={1.8} />
                  </button>
                  {tooltipIconId === opt.id && (
                    <div className="live-asr-tooltip">
                      {TOOLTIP_TEXT[mode]}
                    </div>
                  )}
                </div>
                <span className="live-asr-icon-option-label">{opt.label}</span>
              </div>
            );
          })}
        </div>
      </div>

      {error && <div className="live-asr-error">{error}</div>}

      {/* ── Live streaming transcript ── */}
      {(isLiveActive || isProcessing || segments.length > 0) && (
        <div className="live-asr-live-section">
          {segments.length === 0 ? (
            <div className="live-asr-empty">
              {isProcessing ? 'Processing…' : 'Hold an icon and speak…'}
            </div>
          ) : (
            <div className="live-asr-segments">
              {segments.map(seg => (
                <div key={seg.id} className="live-asr-segment">
                  <div className="live-asr-segment-meta">
                    <span className="gcs-transcript-lang-badge">{seg.lang}</span>
                    <span className="live-asr-meta-sep" />
                    <span className="live-asr-meta-item">{fmtTime(seg.startedAt)}</span>
                    <span className="live-asr-meta-item">avg {avgMs(seg.chunks)} ms</span>
                    <span className="live-asr-meta-item">{seg.chunks.length} chunk{seg.chunks.length !== 1 ? 's' : ''}</span>
                    {totalCost(seg.chunks) > 0 && (
                      <span className="live-asr-meta-item live-asr-seg-cost">{totalCost(seg.chunks).toFixed(4)} OTC</span>
                    )}
                    {seg.chunks.length > 0 && (
                      <span className="live-asr-meta-item">
                        {seg.chunks.map((c, i) => (
                          <span
                            key={i}
                            className="live-asr-chunk-badge"
                            title={`model: ${c.model} · audio: ${c.durationMs}ms · cost: ${c.costUsd.toFixed(6)} USD`}
                          >
                            {c.latencyMs}ms{c.durationMs > 0 ? ` / ${c.durationMs}ms` : ''}{c.costOtcoin > 0 ? ` · ${c.costOtcoin.toFixed(3)}🪙` : ''}
                          </span>
                        ))}
                      </span>
                    )}
                  </div>
                  <p className="gcs-transcript-text">{seg.text}</p>
                </div>
              ))}
              {isProcessing && (
                <div className="live-asr-processing-indicator">
                  <span className="live-asr-dot processing" /><span>Processing…</span>
                </div>
              )}
            </div>
          )}
          {segments.length > 0 && (
            <div className="live-asr-actions">
              <button className="console-secondary-button" onClick={() => { syncSegments([]); setTotalChunks(0); setSessionTotalCostOtcoin(0); }} type="button">Clear</button>
            </div>
          )}
        </div>
      )}

      {/* ── Record mode result ── */}
      {status === 'recorded' && recordedBlob && (
        <div className="live-asr-record-result">
          <div className="live-asr-record-meta">
            <span className="live-asr-meta-item">Duration: {fmtDuration(recordedDuration)}</span>
            <span className="live-asr-meta-item">Size: {(recordedBlob.size / 1024).toFixed(1)} KB</span>
          </div>
          {audioUrl && (
            <audio controls src={audioUrl} className="live-asr-audio-player" />
          )}
          {savedPath ? (
            <div className="live-asr-saved-path">
              <span className="live-asr-saved-label">Saved:</span>
              <code>{savedPath}</code>
            </div>
          ) : (
            <div className="live-asr-record-actions">
              <button
                className="live-asr-save-btn"
                onClick={() => void handleSaveToGcs()}
                disabled={saveStatus === 'saving'}
                type="button"
              >
                {saveStatus === 'saving' ? 'Saving…' : 'Save to GCS'}
              </button>
              <button className="console-secondary-button" onClick={discardRecording} type="button">
                Discard
              </button>
            </div>
          )}
          {savedPath && (
            <div className="live-asr-record-actions">
              <button className="console-secondary-button" onClick={discardRecording} type="button">New Recording</button>
            </div>
          )}
        </div>
      )}

    </div>
  );
}
