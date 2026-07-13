// FILE: ~/otmega/otmega_app/console/admin_frontend/src/components/devlog/DevLogCasePanel.tsx
// ماموریت: پنل per-user برای فعال‌سازی DevLog، مشاهده دستگاه/رخداد، countdown و export پرونده.

import { Bug, Download, FilePlus2, Printer, RefreshCw, Square, TimerReset, Upload, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  addDevLogNote,
  createDevLogCase,
  downloadDevLogCaseExport,
  fetchDevLogCase,
  fetchDevLogCases,
  startDevLogRetention,
  stopDevLogCase,
  uploadDevLogArtifact,
  type DevLogCase,
  type UserOpsRow,
} from '../../api/consoleApi';
import { useConsolePageState } from '../../hooks/useConsolePageState';

type DevLogCasePanelProps = {
  row: UserOpsRow;
  canManage: boolean;
  onClose: () => void;
};

function remainingUntil(value: string | null | undefined, now: number): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, Math.floor((timestamp - now) / 1000)) : null;
}

function formatCountdown(seconds: number | null): string {
  if (seconds === null) return 'Not started';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${days ? `${days}d ` : ''}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function formatLatency(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value)} ms` : '—';
}

export default function DevLogCasePanel({ row, canManage, onClose }: DevLogCasePanelProps) {
  const [currentCase, setCurrentCase] = useState<DevLogCase | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [panelSettings, setPanelSettings] = useConsolePageState('user_operations_devlog', {
    captureMinutes: 30,
    retentionDays: 7,
  });
  const captureMinutes = Number(panelSettings.captureMinutes) || 30;
  const retentionDays = Number(panelSettings.retentionDays) || 7;
  const [note, setNote] = useState('');
  const [now, setNow] = useState(Date.now());

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      if (currentCase?.manifest.case_id) {
        const response = await fetchDevLogCase(currentCase.manifest.case_id);
        setCurrentCase(response.case);
      } else {
        const response = await fetchDevLogCases(row.user_id);
        const latest = response.cases[0];
        if (latest?.case_id) {
          const detail = await fetchDevLogCase(latest.case_id);
          setCurrentCase(detail.case);
        } else {
          setCurrentCase(null);
        }
      }
      setError(null);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : 'DevLog refresh failed.');
    } finally {
      setLoading(false);
    }
  }, [currentCase?.manifest.case_id, row.user_id]);

  useEffect(() => {
    setCurrentCase(null);
    setNotice(null);
    setError(null);
  }, [row.user_id]);

  useEffect(() => {
    void refresh();
  }, [row.user_id]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!currentCase || currentCase.manifest.status !== 'active') return undefined;
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => window.clearInterval(timer);
  }, [currentCase?.manifest.case_id, currentCase?.manifest.status, refresh]);

  const captureRemaining = remainingUntil(currentCase?.manifest.capture_expires_at, now);
  const retentionRemaining = remainingUntil(currentCase?.manifest.expires_at, now);
  const devices = currentCase?.devices || [];
  const analytics = currentCase?.analytics;
  const interpretation = analytics?.interpretation;
  const outgoingTraces = analytics?.traces.filter((trace) => trace.kind === 'outgoing_send' || trace.kind === 'outgoing_partial') || [];
  const recentEvents = useMemo(() => (currentCase?.events || []).slice(-200).reverse(), [currentCase?.events]);

  async function runAction(action: string, operation: () => Promise<DevLogCase | null>, success: string) {
    setBusyAction(action);
    try {
      const next = await operation();
      if (next) setCurrentCase(next);
      setNotice(success);
      setError(null);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : `${action} failed.`);
    } finally {
      setBusyAction(null);
    }
  }

  async function createCase() {
    await runAction('create', async () => {
      const response = await createDevLogCase({
        user_id: row.user_id,
        user_label: row.email || row.full_name || row.user_id,
        capture_minutes: captureMinutes,
        retention_days: retentionDays,
      });
      return response.case;
    }, 'DevLog enabled. The user app checks activation every 30 seconds.');
  }

  async function exportCase(format: 'json' | 'csv' | 'md' | 'html') {
    if (!currentCase) return;
    await runAction(`export-${format}`, async () => {
      await downloadDevLogCaseExport(currentCase.manifest.case_id, format);
      const response = await fetchDevLogCase(currentCase.manifest.case_id);
      return response.case;
    }, `${format.toUpperCase()} downloaded; cleanup countdown is now running.`);
  }

  return (
    <aside className="devlog-case-panel">
      <header>
        <Bug aria-hidden="true" size={18} />
        <div>
          <strong>Dev Log · {row.email || row.user_id}</strong>
          <small>{currentCase?.storage_path || 'No case created yet'}</small>
        </div>
        <button className="console-icon-button" onClick={onClose} title="Close Dev Log" type="button"><X aria-hidden="true" size={17} /></button>
      </header>

      <div className="devlog-case-toolbar">
        <button className="console-icon-text-button" disabled={loading || Boolean(busyAction)} onClick={() => void refresh()} type="button">
          <RefreshCw aria-hidden="true" className={loading ? 'spin' : undefined} size={15} /> Refresh
        </button>
        {!currentCase || currentCase.manifest.status !== 'active' || captureRemaining === 0 ? (
          <>
            <label>Capture
              <select onChange={(event) => setPanelSettings((previous) => ({ ...previous, captureMinutes: Number(event.target.value) }))} value={captureMinutes}>
                <option value={15}>15 minutes</option><option value={30}>30 minutes</option><option value={60}>1 hour</option><option value={180}>3 hours</option>
              </select>
            </label>
            <label>Retention
              <select onChange={(event) => setPanelSettings((previous) => ({ ...previous, retentionDays: Number(event.target.value) }))} value={retentionDays}>
                <option value={1}>1 day after download</option><option value={7}>7 days after download</option><option value={14}>14 days after download</option>
              </select>
            </label>
            <button className="console-icon-text-button" disabled={!canManage || Boolean(busyAction)} onClick={() => void createCase()} type="button">
              <FilePlus2 aria-hidden="true" className={busyAction === 'create' ? 'spin' : undefined} size={15} /> Enable DevLog
            </button>
          </>
        ) : null}
        {currentCase?.manifest.status === 'active' && captureRemaining !== 0 ? (
          <button className="console-secondary-button" disabled={!canManage || Boolean(busyAction)} onClick={() => void runAction('stop', async () => (await stopDevLogCase(currentCase.manifest.case_id)).case, 'Capture stopped; logs remain until retention starts and expires.')} type="button">
            <Square aria-hidden="true" className={busyAction === 'stop' ? 'spin' : undefined} size={14} /> Stop capture
          </button>
        ) : null}
      </div>

      {error ? <div className="console-error">{error}</div> : null}
      {notice ? <div className="console-notice">{notice}</div> : null}

      {currentCase ? (
        <>
          <section className="devlog-case-status-grid">
            <article><span>Status</span><strong>{currentCase.manifest.status}</strong><small>{currentCase.event_count} events</small></article>
            <article><span>Capture remaining</span><strong>{formatCountdown(captureRemaining)}</strong><small>auto-stops at {new Date(currentCase.manifest.capture_expires_at).toLocaleString()}</small></article>
            <article className={currentCase.manifest.retention_started_at ? 'countdown-running' : 'countdown-pending'}>
              <span>Deletion countdown</span>
              <strong>{formatCountdown(retentionRemaining)}</strong>
              <small>{currentCase.manifest.retention_started_at ? `deletes after ${new Date(currentCase.manifest.expires_at || '').toLocaleString()}` : 'Will not start until first successful download or manual start'}</small>
            </article>
          </section>

          <section className="devlog-case-actions">
            {(['json', 'csv', 'md', 'html'] as const).map((format) => (
              <button className="console-icon-text-button" disabled={Boolean(busyAction)} key={format} onClick={() => void exportCase(format)} type="button">
                <Download aria-hidden="true" className={busyAction === `export-${format}` ? 'spin' : undefined} size={14} /> {format.toUpperCase()}
              </button>
            ))}
            <button className="console-icon-text-button" onClick={() => window.print()} type="button">
              <Printer aria-hidden="true" size={14} /> Print analysis
            </button>
            {!currentCase.manifest.retention_started_at ? (
              <button className="console-secondary-button" disabled={!canManage || Boolean(busyAction)} onClick={() => void runAction('retention', async () => (await startDevLogRetention(currentCase.manifest.case_id)).case, 'Cleanup countdown started manually.')} type="button">
                <TimerReset aria-hidden="true" className={busyAction === 'retention' ? 'spin' : undefined} size={14} /> Start countdown
              </button>
            ) : null}
            <label className="console-secondary-button devlog-artifact-upload">
              <Upload aria-hidden="true" className={busyAction === 'artifact' ? 'spin' : undefined} size={14} /> Add screenshot/artifact
              <input accept="image/*,.pdf,.txt,.md,.json" disabled={!canManage || Boolean(busyAction)} onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                void runAction('artifact', async () => (await uploadDevLogArtifact(currentCase.manifest.case_id, file)).case, 'Artifact saved inside this case path.');
                event.target.value = '';
              }} type="file" />
            </label>
          </section>

          <section className="devlog-case-note">
            <textarea onChange={(event) => setNote(event.target.value)} placeholder="Customer report, reproduction note or follow-up..." value={note} />
            <button className="console-secondary-button" disabled={!canManage || !note.trim() || Boolean(busyAction)} onClick={() => void runAction('note', async () => {
              const response = await addDevLogNote(currentCase.manifest.case_id, note);
              setNote('');
              return response.case;
            }, 'Note added.')} type="button">Add note</button>
          </section>

          <section className="devlog-case-analysis">
            <h3>Computed sequence analysis</h3>
            {interpretation ? (
              <section className="devlog-interpretation">
                <header>
                  <div><strong>Deterministic case analysis</strong><small>Version {interpretation.analysis_version} · {interpretation.snapshot_status.replaceAll('_', ' ')}</small></div>
                  <div className="devlog-analysis-badges">
                    <span>{interpretation.classification.replaceAll('_', ' ')}</span>
                    <span className={`confidence-${interpretation.confidence}`}>{interpretation.confidence} confidence</span>
                    <span>{interpretation.severity}</span>
                  </div>
                </header>
                <small>{interpretation.confidence_basis}</small>
                <div className="devlog-interpretation-grid">
                  <article>
                    <h4>Management analysis</h4>
                    <ul>{interpretation.management_summary.map((item) => <li key={item}>{item}</li>)}</ul>
                  </article>
                  <article>
                    <h4>Technical analysis</h4>
                    <ul>{interpretation.technical_analysis.map((item) => <li key={item}>{item}</li>)}</ul>
                  </article>
                </div>
                <p className="devlog-next-action"><strong>Next diagnostic action</strong>{interpretation.next_diagnostic_action}</p>
                <details className="devlog-analysis-references">
                  <summary>Related code files, documents and limitations</summary>
                  <div className="devlog-reference-grid">
                    <article><h4>Code files</h4>{interpretation.related_files.map((item) => <p key={item.path}><code>{item.path}</code><small>{item.component} · {item.reason}</small></p>)}</article>
                    <article><h4>Documents</h4>{interpretation.related_documents.map((item) => <p key={item.path}><code>{item.path}</code><small>{item.title}</small></p>)}</article>
                  </div>
                  <h4>Limitations</h4>
                  <ul>{interpretation.limitations.map((item) => <li key={item}>{item}</li>)}</ul>
                </details>
              </section>
            ) : null}
            <div className="devlog-analysis-summary">
              <article><span>Traces</span><strong>{analytics?.summary.trace_count || 0}</strong><small>{analytics?.summary.outgoing_send_trace_count || 0} outgoing ({analytics?.summary.outgoing_partial_trace_count || 0} partial) · {analytics?.summary.observed_incoming_trace_count || 0} observed incoming</small></article>
              <article><span>HTTP ACK average</span><strong>{formatLatency(analytics?.latency_stats.http_start_to_ack_ms?.avg_ms)}</strong><small>client HTTP start → response ACK</small></article>
              <article><span>Canonical average</span><strong>{formatLatency(analytics?.latency_stats.http_start_to_canonical_ms?.avg_ms)}</strong><small>HTTP start → canonical observed</small></article>
              <article><span>Delivered average</span><strong>{formatLatency(analytics?.latency_stats.http_start_to_delivered_observed_ms?.avg_ms)}</strong><small>HTTP start → delivered observed</small></article>
              <article><span>Read average</span><strong>{formatLatency(analytics?.latency_stats.http_start_to_read_observed_ms?.avg_ms)}</strong><small>HTTP start → read observed</small></article>
              <article><span>Backend RPC average</span><strong>{formatLatency(analytics?.latency_stats.backend_rpc_cumulative_ms?.avg_ms)}</strong><small>cumulative from backend send entry</small></article>
              <article><span>Backend saved average</span><strong>{formatLatency(analytics?.latency_stats.backend_saved_cumulative_ms?.avg_ms)}</strong><small>cumulative through saved milestone</small></article>
              <article className={(analytics?.summary.attention_flag_count || 0) > 0 ? 'analysis-attention' : ''}><span>Attention flags</span><strong>{analytics?.summary.attention_flag_count || 0}</strong><small>{analytics?.attention_flags.join(', ') || 'No computed flags'}</small></article>
              <article><span>Ordering notes</span><strong>{analytics?.summary.ordering_note_count || 0}</strong><small>{analytics?.ordering_notes.join(', ') || 'No ordering note'}</small></article>
            </div>
            <div className="devlog-analysis-coverage">
              {Object.entries(analytics?.coverage || {}).map(([key, available]) => (
                <span className={available ? 'coverage-yes' : 'coverage-no'} key={key}>{available ? 'CAPTURED' : 'NOT CAPTURED'} · {key}</span>
              ))}
            </div>
            <div className="devlog-trace-analysis-table">
              <div className="devlog-trace-analysis-head"><span>Trace / message</span><span>HTTP ACK</span><span>Canonical</span><span>Delivered</span><span>Read</span><span>RPC</span><span>Saved</span><span>Post</span><span>Reconcile</span><span>Evidence / ordering</span></div>
              {outgoingTraces.map((trace) => (
                <details key={trace.trace_id}>
                  <summary>
                    <span><code>{trace.trace_id.slice(-18)}</code><small>{trace.kind === 'outgoing_partial' ? 'partial outgoing · ' : ''}{trace.message_id?.slice(-12) || trace.client_message_id?.slice(-12) || 'no message id'}</small></span>
                    <span>{formatLatency(trace.latency.http_start_to_ack_ms)}</span>
                    <span>{formatLatency(trace.latency.http_start_to_canonical_ms)}</span>
                    <span>{formatLatency(trace.latency.http_start_to_delivered_observed_ms)}</span>
                    <span>{formatLatency(trace.latency.http_start_to_read_observed_ms)}</span>
                    <span>{formatLatency(trace.latency.backend_rpc_cumulative_ms)}</span>
                    <span>{formatLatency(trace.latency.backend_saved_cumulative_ms)}</span>
                    <span>{formatLatency(trace.latency.backend_post_processing_cumulative_ms)}</span>
                    <span>{trace.reconcile.replace} replace / {trace.reconcile.insert} insert</span>
                    <span>{[...trace.attention_flags, ...trace.ordering_notes, ...trace.evidence_gaps].join(', ') || '—'}</span>
                  </summary>
                  <div className="devlog-trace-sequence">{trace.event_sequence.join(' → ')}</div>
                </details>
              ))}
              {!outgoingTraces.length ? <p>No outgoing send trace is available yet.</p> : null}
            </div>
            <p className="devlog-analysis-note">Coverage means the DevLog event was captured; it does not claim that an uncaptured product state did not happen. Negative ACK→Canonical means realtime canonical arrived before the HTTP response. “Saved” and “Post” are cumulative backend durations; JSON/CSV/MD exports include this complete analysis.</p>
          </section>

          <section className="devlog-case-devices">
            <h3>Captured devices ({devices.length})</h3>
            <div>{devices.length ? devices.map((device) => (
              <article key={device.device_session_ref}>
                <strong>{device.device_key}</strong>
                <small>{device.os} · {device.browser} · {device.runtime_kind} · {device.native_platform}</small>
                <small>{device.frontend_version} · session {device.device_session_ref.slice(-12)}</small>
              </article>
            )) : <p>No device events captured yet. Keep the user app open for up to 30 seconds after activation.</p>}</div>
          </section>

          <section className="devlog-case-events">
            <h3>Latest events</h3>
            <div className="devlog-event-table">
              {recentEvents.map((event) => (
                <div key={event.event_id}>
                  <time>{new Date(event.server_received_at || event.client_wall_at || '').toLocaleTimeString()}</time>
                  <code>{event.event_code}</code>
                  <span>{event.source}</span>
                  <span>{event.device?.device_key || 'unknown device'}</span>
                  <small>{event.reason_code || event.status || ''}</small>
                </div>
              ))}
              {!recentEvents.length ? <p>No events stored yet.</p> : null}
            </div>
          </section>

          <section className="devlog-case-artifacts">
            <h3>Artifacts ({currentCase.artifacts.length})</h3>
            {currentCase.artifacts.map((artifact) => <p key={artifact.path}><code>{artifact.name}</code> · {artifact.size} bytes</p>)}
          </section>
        </>
      ) : loading ? <p>Loading DevLog cases...</p> : <p>Enable a temporary case for this user. No deletion countdown starts before a download.</p>}
    </aside>
  );
}
