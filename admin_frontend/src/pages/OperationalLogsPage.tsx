// FILE: ~/otmega/otmega_app/console/admin_frontend/src/pages/OperationalLogsPage.tsx
// ماموریت: نمایش و export لاگ های read-only عملیاتی از منابع allowlist شده.

import { Download, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { fetchOperationalLogs, type CloudRunLogEntry, type CloudRunLogsResponse, type OperationalLogSource } from '../api/consoleApi';

const severityOptions = ['DEFAULT', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'];
const sourceOptions: Array<{ value: OperationalLogSource; label: string }> = [
  { value: 'cloud-run-console', label: 'Cloud Run Console' },
  { value: 'cloud-build', label: 'Cloud Build' },
];

function formatDate(value: string | null): string {
  if (!value) return 'unknown';
  return new Date(value).toLocaleString();
}

function downloadText(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function stamp(payload: CloudRunLogsResponse): string {
  return (payload.timestamp || new Date().toISOString()).replace(/[:.]/g, '-');
}

function csvCell(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function buildCsv(payload: CloudRunLogsResponse): string {
  const headers = ['timestamp', 'severity', 'event', 'build_status', 'artifact_digest', 'status', 'method', 'url', 'latency', 'revision', 'insert_id', 'message'];
  const rows = payload.entries.map((entry) => [
    entry.timestamp,
    entry.severity,
    entry.event,
    entry.build_status,
    entry.artifact_digest,
    entry.status,
    entry.http_method,
    entry.request_url,
    entry.latency,
    entry.revision,
    entry.insert_id,
    entry.message,
  ]);
  return [headers.map(csvCell).join(','), ...rows.map((row) => row.map(csvCell).join(','))].join('\n');
}

function buildMarkdown(payload: CloudRunLogsResponse): string {
  const lines = [
    '# Operational Logs',
    '',
    `- Project: ${payload.project_id}`,
    `- Source: ${payload.source}`,
    `- Service: ${payload.service}`,
    `- Region: ${payload.region}`,
    `- Window: ${payload.hours}h`,
    `- Severity: ${payload.severity}`,
    `- Rows: ${payload.entries.length}`,
    `- Exported at: ${payload.timestamp}`,
    '',
    payload.source === 'cloud-build'
      ? '| Time | Severity | Event | Build | Status/Digest | Message |'
      : '| Time | Severity | HTTP | Revision | Message |',
    payload.source === 'cloud-build'
      ? '| :--- | :--- | :--- | :--- | :--- | :--- |'
      : '| :--- | :--- | :--- | :--- | :--- |',
    ...payload.entries.map((entry) => {
      const http = [entry.http_method, entry.status].filter(Boolean).join(' ');
      const message = (entry.message || entry.request_url || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
      if (payload.source === 'cloud-build') {
        const digest = entry.artifact_digest ? entry.artifact_digest.slice(0, 24) : entry.build_status || 'unknown';
        return `| ${formatDate(entry.timestamp)} | ${entry.severity} | ${entry.event || 'log'} | ${entry.revision} | ${digest} | ${message || 'n/a'} |`;
      }
      return `| ${formatDate(entry.timestamp)} | ${entry.severity} | ${http || 'n/a'} | ${entry.revision} | ${message || 'n/a'} |`;
    }),
    '',
  ];
  return lines.join('\n');
}

function severityClass(entry: CloudRunLogEntry): string {
  if (['ERROR', 'CRITICAL', 'ALERT', 'EMERGENCY'].includes(entry.severity)) return 'error';
  if (entry.severity === 'WARNING') return 'warn';
  return 'ok';
}

function buildSignal(entry: CloudRunLogEntry): string {
  if (entry.artifact_digest) return entry.artifact_digest.slice(0, 24);
  if (entry.build_status && entry.build_status !== 'unknown') return entry.build_status;
  return entry.event || 'log';
}

export default function OperationalLogsPage() {
  const [source, setSource] = useState<OperationalLogSource>('cloud-run-console');
  const [hours, setHours] = useState(1);
  const [severity, setSeverity] = useState('DEFAULT');
  const [limit, setLimit] = useState(50);
  const [payload, setPayload] = useState<CloudRunLogsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function refreshLogs() {
    setLoading(true);
    try {
      const nextPayload = await fetchOperationalLogs({ source, hours, severity, limit });
      setPayload(nextPayload);
      setError(null);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : 'Cloud Run logs failed.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refreshLogs();
  }, []);

  function exportLogs(format: 'json' | 'csv' | 'md') {
    if (!payload) return;
    const filenameStamp = stamp(payload);
    if (format === 'json') {
      downloadText(`${payload.source}-logs-${filenameStamp}.json`, JSON.stringify(payload, null, 2), 'application/json;charset=utf-8');
      return;
    }
    if (format === 'csv') {
      downloadText(`${payload.source}-logs-${filenameStamp}.csv`, buildCsv(payload), 'text/csv;charset=utf-8');
      return;
    }
    downloadText(`${payload.source}-logs-${filenameStamp}.md`, buildMarkdown(payload), 'text/markdown;charset=utf-8');
  }

  return (
    <section className="console-page">
      <div className="console-page-heading">
        <div>
          <h2>Operational Logs</h2>
          <p>Read-only operational logs from allowlisted Google Cloud sources.</p>
        </div>
        <div className="ops-log-actions">
          <button className="console-icon-text-button" disabled={!payload || loading} onClick={() => exportLogs('json')} type="button">
            <Download aria-hidden="true" size={17} />
            <span>JSON</span>
          </button>
          <button className="console-icon-text-button" disabled={!payload || loading} onClick={() => exportLogs('csv')} type="button">
            <Download aria-hidden="true" size={17} />
            <span>CSV</span>
          </button>
          <button className="console-icon-text-button" disabled={!payload || loading} onClick={() => exportLogs('md')} type="button">
            <Download aria-hidden="true" size={17} />
            <span>Markdown</span>
          </button>
          <button className="console-icon-text-button" disabled={loading} onClick={refreshLogs} type="button">
            <RefreshCw aria-hidden="true" size={17} />
            <span>{loading ? 'Refreshing' : 'Refresh'}</span>
          </button>
        </div>
      </div>

      <div className="ops-log-filters">
        <label>
          <span>Source</span>
          <select value={source} onChange={(event) => setSource(event.target.value as OperationalLogSource)}>
            {sourceOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Window</span>
          <select value={hours} onChange={(event) => setHours(Number(event.target.value))}>
            <option value={1}>1 hour</option>
            <option value={6}>6 hours</option>
            <option value={24}>24 hours</option>
          </select>
        </label>
        <label>
          <span>Severity</span>
          <select value={severity} onChange={(event) => setSeverity(event.target.value)}>
            {severityOptions.map((option) => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Limit</span>
          <select value={limit} onChange={(event) => setLimit(Number(event.target.value))}>
            <option value={25}>25 rows</option>
            <option value={50}>50 rows</option>
            <option value={100}>100 rows</option>
          </select>
        </label>
      </div>

      {error ? <div className="console-error">{error}</div> : null}

      <div className="ops-log-summary">
        <article className="console-panel">
          <span className="console-label">Source</span>
          <strong>{payload?.service || sourceOptions.find((option) => option.value === source)?.label || source}</strong>
          <p>{payload ? `${payload.region} / ${payload.project_id}` : 'Allowlisted operational logs'}</p>
        </article>
        <article className="console-panel">
          <span className="console-label">Last Probe</span>
          <strong>{payload ? formatDate(payload.timestamp) : loading ? 'loading' : 'unknown'}</strong>
          <p>{payload?.http_status ? `${payload.latency_ms} ms / HTTP ${payload.http_status}` : 'Logging API pending'}</p>
        </article>
        <article className="console-panel">
          <span className="console-label">Rows</span>
          <strong>{payload?.entries.length ?? 0}</strong>
          <p>{payload ? `${payload.hours}h / ${payload.severity} / limit ${payload.limit}` : 'No payload yet'}</p>
        </article>
      </div>

      <article className="ops-log-history">
        <div className="ops-log-history-head">
          <span className="console-label">Latest Entries</span>
          <small>{payload?.entries.length ?? 0} rows</small>
        </div>
        <div className="ops-log-table">
          {payload?.source === 'cloud-build' ? (
            <div className="ops-log-row ops-log-row-head ops-log-row-build">
              <span>Time</span>
              <span>Severity</span>
              <span>Event</span>
              <span>Build</span>
              <span>Status/Digest</span>
              <span>Message</span>
            </div>
          ) : (
            <div className="ops-log-row ops-log-row-head">
              <span>Time</span>
              <span>Severity</span>
              <span>HTTP</span>
              <span>Target</span>
              <span>Message</span>
            </div>
          )}
          {(payload?.entries || []).map((entry) => (
            <div className={`ops-log-row ${payload?.source === 'cloud-build' ? 'ops-log-row-build' : ''}`} key={entry.insert_id || `${entry.timestamp}-${entry.message}`}>
              <span>{formatDate(entry.timestamp)}</span>
              <span className={`ops-log-severity status-${severityClass(entry)}`}>{entry.severity}</span>
              <span>{payload?.source === 'cloud-build' ? entry.event || 'log' : [entry.http_method, entry.status].filter(Boolean).join(' ') || 'n/a'}</span>
              <span>{entry.revision}</span>
              {payload?.source === 'cloud-build' ? <span title={entry.artifact_digest || entry.build_status || ''}>{buildSignal(entry)}</span> : null}
              <span title={entry.message || entry.request_url || ''}>{entry.message || entry.request_url || 'n/a'}</span>
            </div>
          ))}
          {!loading && payload?.entries.length === 0 ? <div className="ops-log-empty">No log entries returned.</div> : null}
        </div>
      </article>
    </section>
  );
}
