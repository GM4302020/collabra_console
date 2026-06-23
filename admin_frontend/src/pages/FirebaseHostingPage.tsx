// FILE: ~/otmega/otmega_app/console/admin_frontend/src/pages/FirebaseHostingPage.tsx
// ماموریت: نمایش read-only تاریخچه releaseهای Firebase Hosting اپ Collabra.

import { Download, ExternalLink, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { fetchFirebaseHostingReleases, type FirebaseHostingRelease, type FirebaseHostingReleasesResponse } from '../api/consoleApi';

function formatDate(value: string | null): string {
  if (!value) return 'unknown';
  return new Date(value).toLocaleString();
}

function formatBytes(value: string): string {
  const bytes = Number(value);
  if (!Number.isFinite(bytes)) return value || 'unknown';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function releaseStatusClass(release: FirebaseHostingRelease): string {
  return release.version_status === 'FINALIZED' ? 'ok' : 'warn';
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

function exportStamp(payload: FirebaseHostingReleasesResponse): string {
  return (payload.timestamp || new Date().toISOString()).replace(/[:.]/g, '-');
}

function csvCell(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function buildCsv(payload: FirebaseHostingReleasesResponse): string {
  const headers = [
    'release_type',
    'release_time',
    'version',
    'version_status',
    'file_count',
    'version_bytes',
    'deployment_tool',
    'release_user_email',
    'create_time',
    'finalize_time',
    'name',
  ];
  const rows = payload.releases.map((release) => [
    release.type,
    release.release_time,
    release.version,
    release.version_status,
    release.file_count,
    release.version_bytes,
    release.deployment_tool,
    release.release_user_email,
    release.create_time,
    release.finalize_time,
    release.name,
  ]);
  return [headers.map(csvCell).join(','), ...rows.map((row) => row.map(csvCell).join(','))].join('\n');
}

function buildMarkdown(payload: FirebaseHostingReleasesResponse): string {
  const lines = [
    '# Firebase Hosting Release History',
    '',
    `- Project: ${payload.project_id}`,
    `- Site: ${payload.site_id}`,
    `- Primary URL: ${payload.primary_url}`,
    `- Probe: HTTP ${payload.http_status}, ${payload.latency_ms} ms`,
    `- Exported at: ${payload.timestamp}`,
    '',
    '| Release | Time | Version | Status | Files | Size bytes | Tool | Actor |',
    '| :--- | :--- | :--- | :--- | ---: | ---: | :--- | :--- |',
    ...payload.releases.map((release) =>
      [
        release.type,
        release.release_time || 'unknown',
        release.version,
        release.version_status,
        release.file_count,
        release.version_bytes,
        release.deployment_tool || 'unknown',
        release.release_user_email || 'unknown',
      ].map((value) => String(value).replace(/\|/g, '\\|')).join(' | '),
    ).map((row) => `| ${row} |`),
    '',
  ];
  return lines.join('\n');
}

export default function FirebaseHostingPage() {
  const [payload, setPayload] = useState<FirebaseHostingReleasesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function refreshReleases() {
    setLoading(true);
    try {
      const nextPayload = await fetchFirebaseHostingReleases(10);
      setPayload(nextPayload);
      setError(null);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : 'Firebase Hosting release history failed.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refreshReleases();
  }, []);

  function exportReleases(format: 'json' | 'csv' | 'md') {
    if (!payload) return;
    const stamp = exportStamp(payload);
    if (format === 'json') {
      downloadText(`firebase-hosting-releases-${stamp}.json`, JSON.stringify(payload, null, 2), 'application/json;charset=utf-8');
      return;
    }
    if (format === 'csv') {
      downloadText(`firebase-hosting-releases-${stamp}.csv`, buildCsv(payload), 'text/csv;charset=utf-8');
      return;
    }
    downloadText(`firebase-hosting-releases-${stamp}.md`, buildMarkdown(payload), 'text/markdown;charset=utf-8');
  }

  return (
    <section className="console-page">
      <div className="console-page-heading">
        <div>
          <h2>Firebase Hosting</h2>
          <p>Read-only release history for the Collabra web frontend.</p>
        </div>
        <div className="firebase-release-actions">
          <button className="console-icon-text-button" disabled={!payload || loading} onClick={() => exportReleases('json')} type="button">
            <Download aria-hidden="true" size={17} />
            <span>JSON</span>
          </button>
          <button className="console-icon-text-button" disabled={!payload || loading} onClick={() => exportReleases('csv')} type="button">
            <Download aria-hidden="true" size={17} />
            <span>CSV</span>
          </button>
          <button className="console-icon-text-button" disabled={!payload || loading} onClick={() => exportReleases('md')} type="button">
            <Download aria-hidden="true" size={17} />
            <span>Markdown</span>
          </button>
          <button className="console-icon-text-button" disabled={loading} onClick={refreshReleases} type="button">
            <RefreshCw aria-hidden="true" size={17} />
            <span>{loading ? 'Refreshing' : 'Refresh'}</span>
          </button>
        </div>
      </div>

      {error ? <div className="console-error">{error}</div> : null}

      <div className="firebase-release-summary">
        <article className="console-panel">
          <span className="console-label">Site</span>
          <strong>{payload?.site_id || 'ot-ai-advisor'}</strong>
          <p>{payload?.primary_url || 'https://app.otmega.com'}</p>
        </article>
        <article className="console-panel">
          <span className="console-label">Last Probe</span>
          <strong>{payload ? formatDate(payload.timestamp) : loading ? 'loading' : 'unknown'}</strong>
          <p>{payload ? `${payload.latency_ms} ms / HTTP ${payload.http_status}` : 'release API pending'}</p>
        </article>
        <article className="console-panel">
          <span className="console-label">Links</span>
          <div className="firebase-release-links">
            {payload?.primary_url ? (
              <a href={payload.primary_url} rel="noreferrer" target="_blank">
                <ExternalLink aria-hidden="true" size={14} />
                <span>Open App</span>
              </a>
            ) : null}
            {payload?.console_url ? (
              <a href={payload.console_url} rel="noreferrer" target="_blank">
                <ExternalLink aria-hidden="true" size={14} />
                <span>Firebase Console</span>
              </a>
            ) : null}
          </div>
        </article>
      </div>

      <article className="firebase-release-history">
        <div className="firebase-release-history-head">
          <span className="console-label">Latest Releases</span>
          <small>{payload?.releases.length ?? 0} rows</small>
        </div>
        <div className="firebase-release-table">
          <div className="firebase-release-row firebase-release-row-head">
            <span>Release</span>
            <span>Version</span>
            <span>Status</span>
            <span>Files</span>
            <span>Size</span>
            <span>Actor</span>
          </div>
          {(payload?.releases || []).map((release) => (
            <div className="firebase-release-row" key={release.name || release.version}>
              <span>
                <b>{release.type}</b>
                <small>{formatDate(release.release_time)}</small>
              </span>
              <span>
                <b>{release.version}</b>
                <small>{release.deployment_tool || 'unknown tool'}</small>
              </span>
              <span className={`firebase-release-status status-${releaseStatusClass(release)}`}>{release.version_status}</span>
              <span>{release.file_count}</span>
              <span>{formatBytes(release.version_bytes)}</span>
              <span>{release.release_user_email || 'unknown'}</span>
            </div>
          ))}
          {!loading && payload?.releases.length === 0 ? <div className="firebase-release-empty">No releases returned.</div> : null}
        </div>
      </article>
    </section>
  );
}
