// FILE: ~/otmega/otmega_app/console/admin_frontend/src/components/live-asr/LiveAsrPanel.tsx
// ماموریت: ۴ دکمه مستقل برای تست میکروفن — Collabra Recording، Guest Recording، Collabra Live، Guest Live.

import { useEffect, useRef, useState } from 'react';
import { AudioWaveform, Mic, Pause, Square } from 'lucide-react';
import { sendLiveChunk, uploadAudioToGcs } from '../../api/consoleApi';

// ─── Types & Constants ────────────────────────────────────────────────────────

type RecPhase   = 'idle' | 'recording' | 'paused';
type ActiveUnit = 'collabra-rec' | 'guest-rec' | 'collabra-live' | 'guest-live' | null;
type Status     = 'idle' | 'live-streaming' | 'live-processing' | 'recording' | 'recorded';

const HOLD_THRESHOLD_MS = 220;
const CHUNK_MS          = 3000;
const GCS_UPLOAD_PREFIX = 'users/9197bacb-2387-4639-814f-9d643bbfb245/uploads';

const WHISPER_MODELS = [
  { key: 'whisper-large-v3',       label: 'Groq Whisper Large'        },
  { key: 'whisper-large-v3-turbo', label: 'Groq Whisper Turbo'        },
  { key: 'gpt-4o-transcribe',      label: 'OpenAI GPT-4o Transcribe'  },
  { key: 'gpt-4o-mini-transcribe', label: 'OpenAI GPT-4o Mini'        },
] as const;

// ─── Segment types (Live mode) ────────────────────────────────────────────────

type Segment = {
  id: number;
  model: string;
  lang: string;
  text: string;
  latencyMs: number;
  durationMs: number;
  costOtcoin: number;
  costUsd: number;
  startedAt: Date;
  isError: boolean;
  errorMessage?: string;
};

function fmtTime(d: Date)     { return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
function fmtDuration(sec: number) { return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; }
function modelShortLabel(key: string) {
  if (key === 'whisper-large-v3')       return 'Groq Large';
  if (key === 'whisper-large-v3-turbo') return 'Groq Turbo';
  if (key === 'gpt-4o-transcribe')      return 'GPT-4o Transcribe';
  if (key === 'gpt-4o-mini-transcribe') return 'GPT-4o Mini';
  return key;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function LiveAsrPanel() {
  // ── general
  const [status,       setStatus]       = useState<Status>('idle');
  const [whisperModel, setWhisperModel] = useState<string>('whisper-large-v3');
  const [elapsed,      setElapsed]      = useState(0);
  const [error,        setError]        = useState<string | null>(null);

  // ── button state
  const [recPhase,   setRecPhase]   = useState<RecPhase>('idle');
  const [activeUnit, setActiveUnit] = useState<ActiveUnit>(null);

  // ── live streaming state
  const [segments,               setSegments]               = useState<Segment[]>([]);
  const [totalChunks,            setTotalChunks]            = useState(0);
  const [sessionTotalCostOtcoin, setSessionTotalCostOtcoin] = useState(0);

  // ── record mode state
  const [recordedBlob,     setRecordedBlob]     = useState<Blob | null>(null);
  const [recordedDuration, setRecordedDuration] = useState(0);
  const [saveStatus,       setSaveStatus]       = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [savedPath,        setSavedPath]        = useState<string | null>(null);
  const [audioUrl,         setAudioUrl]         = useState<string | null>(null);

  // ── refs
  const streamRef         = useRef<MediaStream | null>(null);
  const isActiveRef       = useRef(false);
  const liveRecorderRef   = useRef<MediaRecorder | null>(null);
  const fullRecorderRef   = useRef<MediaRecorder | null>(null);
  const fullChunksRef     = useRef<Blob[]>([]);
  const timerRef          = useRef<ReturnType<typeof setInterval> | null>(null);
  const holdTimerRef      = useRef<ReturnType<typeof setTimeout>  | null>(null);
  const elapsedRef        = useRef(0);
  const segmentsRef       = useRef<Segment[]>([]);
  const segIdRef          = useRef(0);
  const activeLiveUnitRef = useRef<'collabra-live' | 'guest-live' | null>(null);

  // ── timer helpers ─────────────────────────────────────────────────────────────

  function startTimer() {
    if (timerRef.current) clearInterval(timerRef.current);
    elapsedRef.current = 0; setElapsed(0);
    timerRef.current = setInterval(() => { elapsedRef.current += 1; setElapsed(elapsedRef.current); }, 1000);
  }

  function pauseTimer() {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
  }

  function resumeTimer() {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => { elapsedRef.current += 1; setElapsed(elapsedRef.current); }, 1000);
  }

  function stopTimer() {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null; setElapsed(0); elapsedRef.current = 0;
  }

  // ── media helpers ─────────────────────────────────────────────────────────────

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

  function syncSegments(updated: Segment[]) { segmentsRef.current = updated; setSegments([...updated]); }

  function appendSegment(transcript: string, lang: string, latencyMs: number, durationMs: number, costOtcoin: number, costUsd: number, model: string) {
    segIdRef.current += 1;
    const newSeg: Segment = {
      id: segIdRef.current, model, lang, text: transcript,
      latencyMs, durationMs, costOtcoin, costUsd,
      startedAt: new Date(), isError: false,
    };
    syncSegments([...segmentsRef.current, newSeg]);
    setTotalChunks(n => n + 1);
    setSessionTotalCostOtcoin(prev => Math.round((prev + costOtcoin) * 10000) / 10000);
  }

  function appendError(errorMsg: string, model: string) {
    segIdRef.current += 1;
    const newSeg: Segment = {
      id: segIdRef.current, model, lang: '—', text: '',
      latencyMs: 0, durationMs: 0, costOtcoin: 0, costUsd: 0,
      startedAt: new Date(), isError: true, errorMessage: errorMsg,
    };
    syncSegments([...segmentsRef.current, newSeg]);
  }

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
        if (result.status === 'error' || result.error) {
          appendError(result.error ?? result.status ?? 'API returned error', model);
        } else {
          appendSegment(
            result.transcript?.trim() || '(empty transcript)',
            result.language_code || 'unknown',
            result.latency_ms ?? 0,
            result.duration_ms ?? 0,
            result.estimated_cost_otcoin ?? 0,
            result.estimated_cost_usd ?? 0,
            result.model_key ?? model,
          );
        }
      } catch (e) {
        const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        appendError(msg, model);
      }
      if (isActiveRef.current) { setStatus('live-streaming'); startChunk(stream, model); } else setStatus('idle');
    };

    recorder.start();
    setTimeout(() => { if (recorder.state === 'recording') recorder.stop(); }, CHUNK_MS);
  }

  async function startLiveStreaming(unit: 'collabra-live' | 'guest-live') {
    const stream = await ensureStream();
    if (!stream) return;
    if (!isActiveRef.current) {
      isActiveRef.current = true;
      activeLiveUnitRef.current = unit;
      setActiveUnit(unit);
      setStatus('live-streaming');
      setError(null);
      startTimer();
      startChunk(stream, whisperModel);
    }
  }

  function stopLiveStreaming() {
    if (!isActiveRef.current) return;
    isActiveRef.current = false;
    activeLiveUnitRef.current = null;
    setActiveUnit(null);
    stopTimer();
    if (liveRecorderRef.current?.state === 'recording') liveRecorderRef.current.stop();
  }

  // ── Full recording ────────────────────────────────────────────────────────────

  async function startFullRecording(unit: 'collabra-rec' | 'guest-rec') {
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
      setRecPhase('idle');
      setActiveUnit(null);
      isActiveRef.current = false;
    };

    recorder.start();
    isActiveRef.current = true;
    setStatus('recording');
    setRecPhase('recording');
    setActiveUnit(unit);
    setError(null);
    setRecordedBlob(null);
    setSavedPath(null);
    startTimer();
  }

  function pauseFullRecording() {
    if (fullRecorderRef.current?.state === 'recording') {
      fullRecorderRef.current.pause();
      setRecPhase('paused');
      pauseTimer();
    }
  }

  function resumeFullRecording() {
    if (fullRecorderRef.current?.state === 'paused') {
      fullRecorderRef.current.resume();
      setRecPhase('recording');
      resumeTimer();
    }
  }

  function stopFullRecording() {
    const state = fullRecorderRef.current?.state;
    if (state === 'recording' || state === 'paused') fullRecorderRef.current!.stop();
  }

  function handleRecordingClick(unit: 'collabra-rec' | 'guest-rec') {
    if (activeUnit === null) {
      void startFullRecording(unit);
    } else if (activeUnit === unit && recPhase === 'recording') {
      pauseFullRecording();
    } else if (activeUnit === unit && recPhase === 'paused') {
      resumeFullRecording();
    }
  }

  // ── GCS save / discard ────────────────────────────────────────────────────────

  async function handleSaveToGcs() {
    if (!recordedBlob) return;
    setSaveStatus('saving');
    try {
      const ts  = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
      const ext = recordedBlob.type.includes('ogg') ? 'ogg' : recordedBlob.type.includes('wav') ? 'wav' : 'webm';
      const result = await uploadAudioToGcs(recordedBlob, `rec_${ts}.${ext}`, GCS_UPLOAD_PREFIX);
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

  // ── Live PTT pointer handlers ─────────────────────────────────────────────────

  function handleLivePointerDown(e: React.PointerEvent, unit: 'collabra-live' | 'guest-live') {
    e.preventDefault();
    if (isActiveRef.current || status === 'live-processing') return;
    setError(null);
    holdTimerRef.current = setTimeout(() => { void startLiveStreaming(unit); }, HOLD_THRESHOLD_MS);
  }

  function handleLivePointerUp(unit: 'collabra-live' | 'guest-live') {
    if (holdTimerRef.current) { clearTimeout(holdTimerRef.current); holdTimerRef.current = null; }
    if (activeLiveUnitRef.current === unit) stopLiveStreaming();
  }

  function handleLivePointerLeave(unit: 'collabra-live' | 'guest-live') {
    if (holdTimerRef.current) { clearTimeout(holdTimerRef.current); holdTimerRef.current = null; }
    if (activeLiveUnitRef.current === unit) stopLiveStreaming();
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────────

  useEffect(() => {
    return () => {
      isActiveRef.current = false;
      liveRecorderRef.current?.stop();
      fullRecorderRef.current?.stop();
      streamRef.current?.getTracks().forEach(t => t.stop());
      if (timerRef.current)    clearInterval(timerRef.current);
      if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    };
  }, []);

  // ── Derived ──────────────────────────────────────────────────────────────────

  const isLiveActive  = status === 'live-streaming' || status === 'live-processing';
  const isRecActive   = recPhase !== 'idle';
  const isAnyActive   = isLiveActive || isRecActive;
  const isProcessing  = status === 'live-processing';

  // ── Collabra recording button helpers ─────────────────────────────────────────

  function collabraRecBtnClass() {
    if (activeUnit === 'collabra-rec' && recPhase === 'recording') return 'lasr-mic-btn lasr-collabra-recording';
    if (activeUnit === 'collabra-rec' && recPhase === 'paused')    return 'lasr-mic-btn lasr-collabra-paused';
    return 'lasr-mic-btn';
  }

  function collabraRecBtnIcon() {
    if (activeUnit === 'collabra-rec' && recPhase === 'paused') return <Pause size={22} />;
    return <Mic size={22} />;
  }

  // ── Guest recording button helpers ────────────────────────────────────────────

  function guestRecBtnClass() {
    if (activeUnit === 'guest-rec' && recPhase === 'recording') return 'lasr-mic-btn lasr-guest-recording';
    if (activeUnit === 'guest-rec' && recPhase === 'paused')    return 'lasr-mic-btn lasr-guest-paused';
    return 'lasr-mic-btn';
  }

  function guestRecBtnIcon() {
    if (activeUnit === 'guest-rec' && recPhase === 'recording') return <Square size={22} />;
    if (activeUnit === 'guest-rec' && recPhase === 'paused')    return <Pause size={22} />;
    return <Mic size={22} />;
  }

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
            {isLiveActive && !isProcessing && (
              <><span className="live-asr-dot recording" /><span>{fmtDuration(elapsed)}</span></>
            )}
            {recPhase === 'recording' && (
              <><span className="live-asr-dot recording-full" /><span>{fmtDuration(elapsed)}</span></>
            )}
            {recPhase === 'paused' && (
              <><span className="live-asr-dot lasr-dot-paused" /><span>Paused {fmtDuration(elapsed)}</span></>
            )}
            {isProcessing && (
              <><span className="live-asr-dot processing" /><span>Processing…</span></>
            )}
            {totalChunks > 0 && !isRecActive && (
              <span>{totalChunks} chunks</span>
            )}
            {sessionTotalCostOtcoin > 0 && (
              <span className="live-asr-session-cost">{sessionTotalCostOtcoin.toFixed(4)} OTC</span>
            )}
          </div>
        )}
      </div>

      {/* ── 4 mic buttons ── */}
      <div className="lasr-buttons-grid">

        {/* ─ Recording section ─ */}
        <div className="lasr-section-label">Recording</div>
        <div className="lasr-buttons-row">

          {/* Collabra Recording */}
          <div className="lasr-button-unit">
            <button
              className={collabraRecBtnClass()}
              onClick={() => handleRecordingClick('collabra-rec')}
              disabled={activeUnit !== null && activeUnit !== 'collabra-rec'}
              type="button"
              title={recPhase === 'paused' && activeUnit === 'collabra-rec' ? 'Click to resume' : recPhase === 'recording' && activeUnit === 'collabra-rec' ? 'Click to pause' : 'Click to start recording'}
            >
              {collabraRecBtnIcon()}
            </button>
            <div className="lasr-unit-info">
              <span className="lasr-unit-label">Collabra Rec</span>
              {activeUnit === 'collabra-rec' ? (
                <>
                  <span className="lasr-unit-hint">
                    {recPhase === 'paused' ? `Paused · ${fmtDuration(elapsed)}` : fmtDuration(elapsed)}
                  </span>
                  <button className="lasr-stop-btn" onClick={stopFullRecording} type="button">Stop & Save</button>
                </>
              ) : (
                <span className="lasr-unit-hint">Click to record</span>
              )}
            </div>
          </div>

          {/* Guest Recording */}
          <div className="lasr-button-unit">
            <button
              className={guestRecBtnClass()}
              onClick={() => handleRecordingClick('guest-rec')}
              disabled={activeUnit !== null && activeUnit !== 'guest-rec'}
              type="button"
              title={recPhase === 'paused' && activeUnit === 'guest-rec' ? 'Click to resume' : recPhase === 'recording' && activeUnit === 'guest-rec' ? 'Click to pause' : 'Click to start recording'}
            >
              {guestRecBtnIcon()}
            </button>
            <div className="lasr-unit-info">
              <span className="lasr-unit-label">Guest Rec</span>
              {activeUnit === 'guest-rec' ? (
                <>
                  <span className="lasr-unit-hint">
                    {recPhase === 'paused' ? `Paused · ${fmtDuration(elapsed)}` : fmtDuration(elapsed)}
                  </span>
                  <button className="lasr-stop-btn" onClick={stopFullRecording} type="button">Stop & Save</button>
                </>
              ) : (
                <span className="lasr-unit-hint">Click to record</span>
              )}
            </div>
          </div>

        </div>

        {/* ─ Live Stream section ─ */}
        <div className="lasr-section-label">Live Stream</div>
        <div className="lasr-buttons-row">

          {/* Collabra Live */}
          <div className="lasr-button-unit">
            <button
              className={`lasr-live-btn${activeUnit === 'collabra-live' ? ' active' : ''}`}
              onPointerDown={(e) => handleLivePointerDown(e, 'collabra-live')}
              onPointerUp={() => handleLivePointerUp('collabra-live')}
              onPointerLeave={() => handleLivePointerLeave('collabra-live')}
              onPointerCancel={() => handleLivePointerLeave('collabra-live')}
              onContextMenu={(e) => e.preventDefault()}
              disabled={(isAnyActive && activeUnit !== 'collabra-live') || isProcessing}
              type="button"
            >
              <AudioWaveform size={22} strokeWidth={1.8} />
            </button>
            <div className="lasr-unit-info">
              <span className="lasr-unit-label">Collabra Live</span>
              {activeUnit === 'collabra-live'
                ? <span className="lasr-unit-hint">{fmtDuration(elapsed)}</span>
                : <span className="lasr-unit-hint">Hold to stream</span>
              }
            </div>
          </div>

          {/* Guest Live */}
          <div className="lasr-button-unit">
            <button
              className={`lasr-live-btn${activeUnit === 'guest-live' ? ' active' : ''}`}
              onPointerDown={(e) => handleLivePointerDown(e, 'guest-live')}
              onPointerUp={() => handleLivePointerUp('guest-live')}
              onPointerLeave={() => handleLivePointerLeave('guest-live')}
              onPointerCancel={() => handleLivePointerLeave('guest-live')}
              onContextMenu={(e) => e.preventDefault()}
              disabled={(isAnyActive && activeUnit !== 'guest-live') || isProcessing}
              type="button"
            >
              <AudioWaveform size={22} strokeWidth={1.8} />
            </button>
            <div className="lasr-unit-info">
              <span className="lasr-unit-label">Guest Live</span>
              {activeUnit === 'guest-live'
                ? <span className="lasr-unit-hint">{fmtDuration(elapsed)}</span>
                : <span className="lasr-unit-hint">Hold to stream</span>
              }
            </div>
          </div>

        </div>
      </div>

      {error && <div className="live-asr-error">{error}</div>}

      {/* ── Live streaming transcript ── */}
      {(isLiveActive || isProcessing || segments.length > 0) && (
        <div className="live-asr-live-section">
          {segments.length === 0 ? (
            <div className="live-asr-empty">
              {isProcessing ? 'Processing…' : 'Hold a Live button and speak…'}
            </div>
          ) : (
            <div className="live-asr-segments">
              {segments.map((seg, idx) => (
                <div key={seg.id} className={`live-asr-segment-card${seg.isError ? ' live-asr-segment-card--error' : ''}`}>
                  <div className="live-asr-card-header">
                    <span className="live-asr-card-index">#{idx + 1}</span>
                    <span className="live-asr-model-tag">{modelShortLabel(seg.model)}</span>
                    <span className="gcs-transcript-lang-badge">{seg.lang}</span>
                    <span className="live-asr-card-time">{fmtTime(seg.startedAt)}</span>
                  </div>
                  {!seg.isError && (
                    <div className="live-asr-card-specs">
                      <span className="live-asr-spec-item"><span className="live-asr-spec-label">Latency</span> {seg.latencyMs} ms</span>
                      {seg.durationMs > 0 && <span className="live-asr-spec-item"><span className="live-asr-spec-label">Audio</span> {seg.durationMs} ms</span>}
                      {seg.costOtcoin > 0 && <span className="live-asr-spec-item"><span className="live-asr-spec-label">Cost</span> {seg.costOtcoin.toFixed(4)} OTC</span>}
                      {seg.costUsd > 0 && <span className="live-asr-spec-item"><span className="live-asr-spec-label">USD</span> ${seg.costUsd.toFixed(6)}</span>}
                    </div>
                  )}
                  {seg.isError
                    ? <p className="live-asr-card-error-text">ERROR: {seg.errorMessage}</p>
                    : <p className="live-asr-card-text">{seg.text}</p>
                  }
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
              <button
                className="console-secondary-button"
                onClick={() => { syncSegments([]); setTotalChunks(0); setSessionTotalCostOtcoin(0); }}
                type="button"
              >
                Clear
              </button>
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
          {audioUrl && <audio controls src={audioUrl} className="live-asr-audio-player" />}
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
              <button className="console-secondary-button" onClick={discardRecording} type="button">
                New Recording
              </button>
            </div>
          )}
        </div>
      )}

    </div>
  );
}
