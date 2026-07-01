// FILE: ~/otmega/otmega_app/console/admin_frontend/src/components/live-translate/LiveTranslatePanel.tsx
// ماموریت: تب Live Translate در Routine Tester؛ گفتار زنده، ترجمه گفتاری، ترنسکریپت و ذخیره session.

import { useEffect, useRef, useState } from 'react';
import { Mic, Play, RotateCcw, Save, Square, Volume2 } from 'lucide-react';
import {
  createLiveTranslateSessionToken,
  fetchLiveTranslateSessionDetail,
  fetchLiveTranslateSessions,
  fetchLiveTranslateConfig,
  LiveTranslateConfigResponse,
  LiveTranslateSaveResponse,
  LiveTranslateSavedSession,
  LiveTranslateSessionDetailResponse,
  LiveTranslateSegmentPayload,
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

const WS_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained';
const AUDIO_CHUNK_MS = 100;
const MAX_QUEUED_AUDIO_CHUNKS = 600;
const STOP_SETUP_WAIT_MS = 8000;
const RESPONSE_DRAIN_MS = 6000;
const SETUP_COMPLETE_LOG_MS = 8000;

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

export default function LiveTranslatePanel() {
  const [config, setConfig] = useState<LiveTranslateConfigResponse | null>(null);
  const [targetLang, setTargetLang] = useState('en');
  const [echoTarget, setEchoTarget] = useState(false);
  const [status, setStatus] = useState<StreamStatus>('idle');
  const [inputSegments, setInputSegments] = useState<Segment[]>([]);
  const [outputSegments, setOutputSegments] = useState<Segment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<LiveTranslateSaveResponse | null>(null);
  const [savedSessions, setSavedSessions] = useState<LiveTranslateSavedSession[]>([]);
  const [sessionDetail, setSessionDetail] = useState<LiveTranslateSessionDetailResponse | null>(null);
  const [sessionBrowserStatus, setSessionBrowserStatus] = useState('idle');
  const [monitor, setMonitor] = useState({
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
  });

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
  const eventLogRef = useRef<Array<Record<string, unknown>>>([]);

  function recordEvent(event: string, details?: Record<string, unknown>) {
    eventLogRef.current.push({
      at: new Date().toISOString(),
      event,
      ...(details ? { details } : {}),
    });
    if (eventLogRef.current.length > 500) eventLogRef.current.shift();
  }

  useEffect(() => {
    let ignore = false;
    fetchLiveTranslateConfig()
      .then((payload) => {
        if (ignore) return;
    setConfig(payload);
        setTargetLang(payload.default_target_language_code || 'en');
        recordEvent('config.loaded', { model: payload.model, auth: payload.auth });
      })
      .catch((exc) => {
        if (!ignore) setError(exc instanceof Error ? exc.message : 'Live Translate config failed.');
      });
    void loadSavedSessions();
    return () => { ignore = true; cleanup(); };
  }, []);

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
    setError(null);
    setMonitor({
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
    });
    setStatus('idle');
  }

  async function startStream() {
    if (status === 'live' || status === 'connecting' || status === 'recording') return;
    setError(null);
    setSaved(null);
    eventLogRef.current = [];
    recordEvent('stream.start_clicked', { targetLang, echoTarget });
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
      }), 25000, 'Live Translate token request timed out.');
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
        const setupPayload = {
          setup: {
            model: tokenPayload.model_resource,
            inputAudioTranscription: {},
            outputAudioTranscription: {},
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
              },
            },
          },
        };
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
        setMonitor((prev) => ({ ...prev, websocket: 'closed', lastEvent: closeNote }));
        setStatus((current) => (localCaptureActiveRef.current && (current === 'live' || current === 'connecting' || current === 'recording') ? 'recording' : 'stopped'));
      };
    } catch (exc) {
      recordEvent('stream.start_failed', { message: exc instanceof Error ? exc.message : String(exc) });
      cleanup();
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
    const chunkSamples = Math.round((INPUT_SAMPLE_RATE * AUDIO_CHUNK_MS) / 1000);
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
          source_seconds: Math.round((sourcePcmChunksRef.current.length * AUDIO_CHUNK_MS) / 100) / 10,
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
    setStatus('stopped');
  }

  function scheduleStopWithoutSocketTimeout(reason: string, delayMs: number) {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
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
    scheduleWebSocketClose('response_drain_after_audio_end', RESPONSE_DRAIN_MS);
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
      return;
    }
    if (message.setupComplete) {
      if (setupCompleteTimerRef.current) clearTimeout(setupCompleteTimerRef.current);
      setupCompleteTimerRef.current = null;
      recordEvent('server.setup_complete');
      setupCompleteRef.current = true;
      const flushed = flushQueuedAudio('setup_complete');
      setStatus(stopRequestedRef.current ? 'draining' : 'live');
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

  async function replayAudio(kind: 'source' | 'target') {
    const chunks = kind === 'source' ? sourcePcmChunksRef.current : targetPcmChunksRef.current;
    if (!chunks.length) return;
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
    try {
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
        metadata: { source: 'admin_console_routine_tester', monitor, frontend_log: eventLogRef.current },
      });
      setSaved(response);
      await loadSavedSessions(response.session_id);
      setStatus('stopped');
    } catch (exc) {
      setStatus('stopped');
      setError(exc instanceof Error ? exc.message : 'Save session failed.');
    }
  }

  async function loadSavedSessions(selectSessionId?: string) {
    setSessionBrowserStatus('loading');
    try {
      const response = await fetchLiveTranslateSessions(10);
      setSavedSessions(response.sessions);
      setSessionBrowserStatus('ready');
      const targetSessionId = selectSessionId || response.sessions[0]?.session_id;
      if (targetSessionId) await loadSessionDetail(targetSessionId);
    } catch (exc) {
      setSessionBrowserStatus(exc instanceof Error ? exc.message : 'Session list failed.');
    }
  }

  async function loadSessionDetail(sessionId: string) {
    setSessionBrowserStatus('loading detail');
    try {
      const detail = await fetchLiveTranslateSessionDetail(sessionId);
      setSessionDetail(detail);
      setSessionBrowserStatus('ready');
    } catch (exc) {
      setSessionBrowserStatus(exc instanceof Error ? exc.message : 'Session detail failed.');
    }
  }

  const canSave = inputSegments.length > 0 || outputSegments.length > 0 || sourcePcmChunksRef.current.length > 0 || targetPcmChunksRef.current.length > 0;
  const isRunning = status === 'connecting' || status === 'recording' || status === 'live' || status === 'draining' || localCaptureActiveRef.current;

  return (
    <div className="live-translate-panel">
      <div className="live-translate-toolbar">
        <select
          className="gcs-transcript-llm-select"
          disabled={isRunning}
          onChange={(event) => setTargetLang(event.target.value)}
          value={targetLang}
        >
          {(config?.supported_languages || [{ code: 'en', label: 'English' }]).map((lang) => (
            <option key={lang.code} value={lang.code}>{lang.code.toUpperCase()} · {lang.label}</option>
          ))}
        </select>
        <label className="live-translate-check">
          <input
            checked={echoTarget}
            disabled={isRunning}
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

      <div className="live-translate-actions">
        {!isRunning ? (
          <button className="live-translate-primary" disabled={!config} onClick={() => void startStream()} type="button">
            <Mic size={18} /> Start stream
          </button>
        ) : (
          <button className="live-translate-stop" onClick={stopStream} type="button">
            <Square size={18} /> Stop
          </button>
        )}
        <button className="console-secondary-button" disabled={!canSave || isRunning || status === 'saving'} onClick={() => void saveSession()} type="button">
          <Save size={16} /> Save session
        </button>
        <button className="console-secondary-button" disabled={isRunning || sourcePcmChunksRef.current.length === 0} onClick={() => void replayAudio('source')} type="button">
          <Play size={16} /> Source
        </button>
        <button className="console-secondary-button" disabled={isRunning || targetPcmChunksRef.current.length === 0} onClick={() => void replayAudio('target')} type="button">
          <Volume2 size={16} /> Target
        </button>
        <button className="console-secondary-button" disabled={isRunning} onClick={resetSession} type="button">
          <RotateCcw size={16} /> New session
        </button>
      </div>

      <div className="live-translate-monitor">
        <span>Token: {monitor.token}</span>
        <span>Auth: {config?.auth?.token_strategy || 'unknown'} / key {config?.auth?.api_key_configured ? 'ok' : 'missing'}</span>
        <span>WS: {monitor.websocket}</span>
        <span>Setup: {monitor.setup}</span>
        <span>Mic: {monitor.mic}</span>
        <span>Captured: {monitor.chunksCaptured} chunks / {monitor.sourceSeconds}s / {(monitor.sourceBytes / 1024).toFixed(1)} KB</span>
        <span>Queued: {monitor.queuedChunks} chunks</span>
        <span>Sent: {monitor.chunksSent} chunks</span>
        <span>Level: {monitor.level}% / peak {monitor.peak}%</span>
        <span>Target: {monitor.targetChunks} chunks / {monitor.targetSeconds}s</span>
        <span>Server: {monitor.serverMessages} msgs</span>
        <span>Last: {monitor.lastEvent}</span>
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
            <span className="gcs-transcript-lang-badge">{targetLang.toUpperCase()}</span>
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
                {sessionDetail.source_audio_url ? <audio controls src={sessionDetail.source_audio_url} /> : <small>not saved</small>}
              </label>
              <label>
                <span>Target audio</span>
                {sessionDetail.target_audio_url ? <audio controls src={sessionDetail.target_audio_url} /> : <small>not saved</small>}
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
