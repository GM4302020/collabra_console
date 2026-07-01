import { ExternalLink, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { fetchSupabaseStatus, type SupabaseStatusResponse } from '../../api/consoleApi';

function formatDate(value?: string | null): string {
  return value ? new Date(value).toLocaleString() : 'unknown';
}

export default function SupabaseStatusPanel() {
  const [payload, setPayload] = useState<SupabaseStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      const next = await fetchSupabaseStatus();
      setPayload(next);
      setError(null);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : 'Supabase status lookup failed.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  return (
    <section className="supabase-panel-stack">
      <div className="console-section-toolbar">
        <div>
          <span className="console-label">Supabase Status</span>
          <strong>{payload?.description || (loading ? 'loading' : 'unknown')}</strong>
        </div>
        <div className="ops-log-actions">
          <a className="console-icon-text-button" href={payload?.source_url || 'https://status.supabase.com/'} rel="noreferrer" target="_blank">
            <ExternalLink aria-hidden="true" size={16} />
            <span>Status Page</span>
          </a>
          <button className="console-icon-text-button" disabled={loading} onClick={refresh} type="button">
            <RefreshCw aria-hidden="true" className={loading ? 'spin' : undefined} size={16} />
            <span>{loading ? 'Refreshing' : 'Refresh'}</span>
          </button>
        </div>
      </div>

      {error ? <div className="console-error">{error}</div> : null}

      <div className="ops-log-summary">
        <article className="console-panel">
          <span className="console-label">Indicator</span>
          <strong>{payload?.indicator || 'unknown'}</strong>
          <p>{payload ? `${payload.latency_ms ?? 0} ms / HTTP ${payload.http_status ?? 'n/a'}` : 'Official status API'}</p>
        </article>
        <article className="console-panel">
          <span className="console-label">Open Incidents</span>
          <strong>{payload?.incidents.length ?? 0}</strong>
          <p>{payload ? `Checked ${formatDate(payload.checked_at)}` : 'pending'}</p>
        </article>
        <article className="console-panel">
          <span className="console-label">Maintenance</span>
          <strong>{payload?.scheduled_maintenances.length ?? 0}</strong>
          <p>Scheduled items from Supabase status</p>
        </article>
      </div>

      <div className="console-table-wrap">
        <table className="console-data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Status</th>
              <th>Impact</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {(payload?.incidents || []).map((incident, index) => (
              <tr key={`${incident.name || 'incident'}-${index}`}>
                <td>{incident.shortlink ? <a href={incident.shortlink} rel="noreferrer" target="_blank">{incident.name || 'incident'}</a> : incident.name || 'incident'}</td>
                <td>{incident.status || 'unknown'}</td>
                <td>{incident.impact || 'unknown'}</td>
                <td>{formatDate(incident.updated_at)}</td>
              </tr>
            ))}
            {payload && payload.incidents.length === 0 ? (
              <tr>
                <td colSpan={4}>No active incident returned by the status API.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
