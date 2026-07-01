import { ExternalLink, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { fetchSupabaseDatabaseOverview, type SupabaseDatabaseOverviewResponse } from '../../api/consoleApi';

function formatDate(value?: string | null): string {
  return value ? new Date(value).toLocaleString() : 'unknown';
}

function rowCount(value: number | null): string {
  return value === null ? 'unknown' : value.toLocaleString();
}

export default function DatabaseOverviewPanel() {
  const [payload, setPayload] = useState<SupabaseDatabaseOverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      const next = await fetchSupabaseDatabaseOverview();
      setPayload(next);
      setError(null);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : 'Database overview failed.');
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
          <span className="console-label">Database Overview</span>
          <strong>{payload?.project.project_id || 'Supabase project'}</strong>
        </div>
        <div className="ops-log-actions">
          {payload?.project.dashboard_url ? (
            <a className="console-icon-text-button" href={payload.project.dashboard_url} rel="noreferrer" target="_blank">
              <ExternalLink aria-hidden="true" size={16} />
              <span>Dashboard</span>
            </a>
          ) : null}
          <button className="console-icon-text-button" disabled={loading} onClick={refresh} type="button">
            <RefreshCw aria-hidden="true" className={loading ? 'spin' : undefined} size={16} />
            <span>{loading ? 'Refreshing' : 'Refresh'}</span>
          </button>
        </div>
      </div>

      {error ? <div className="console-error">{error}</div> : null}

      <div className="ops-log-summary">
        <article className="console-panel">
          <span className="console-label">Project URL</span>
          <strong>{payload?.project.url || 'unknown'}</strong>
          <p>advisor {payload?.project.advisor_id ?? 20018}</p>
        </article>
        <article className="console-panel">
          <span className="console-label">Tables</span>
          <strong>{payload?.tables.length ?? 0}</strong>
          <p>{payload ? `${payload.errors.length} warnings / ${payload.latency_ms} ms` : 'pending'}</p>
        </article>
        <article className="console-panel">
          <span className="console-label">Checked</span>
          <strong>{formatDate(payload?.checked_at)}</strong>
          <p>Read-only REST probes</p>
        </article>
      </div>

      <div className="console-table-wrap">
        <table className="console-data-table">
          <thead>
            <tr>
              <th>Table</th>
              <th>Status</th>
              <th>Rows</th>
              <th>Fields</th>
              <th>HTTP</th>
              <th>Indexes</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {(payload?.tables || []).map((table) => (
              <tr key={table.name}>
                <td><code>{table.name}</code></td>
                <td>{table.status}</td>
                <td>{rowCount(table.row_count)}</td>
                <td><b>{table.documented_field_count}</b><small>{table.documented_fields.join(', ') || 'not listed'}</small></td>
                <td>{table.http_status || 'n/a'}</td>
                <td>{table.documented_indexes.length ? table.documented_indexes.join(', ') : 'not listed'}</td>
                <td>{table.notes}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="console-panel">
        <span className="console-label">Pre-change Checklist</span>
        <ul className="supabase-checklist">
          {(payload?.checklist || []).map((item) => <li key={item}>{item}</li>)}
        </ul>
      </div>
    </section>
  );
}
