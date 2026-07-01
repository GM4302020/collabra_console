import { Download, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  fetchConsoleDashboardSettings,
  fetchSupabaseLipWf1Audit,
  saveConsoleDashboardSettingsSection,
  type SupabaseLipWf1AuditResponse,
} from '../../api/consoleApi';

type AuditSettings = {
  advisorId: number;
  limit: number;
  conversationId: string;
  createdAtFrom: string;
  createdAtTo: string;
  visibleColumns: string[];
};

const DEFAULT_COLUMNS = ['created_at', 'emails', 'languages', 'data_kind', 'models', 'fallback'];
const RAW_FIELD_COLUMNS = [
  'id',
  'conversation_id',
  'sender_id',
  'advisor_id',
  'content_original',
  'src_lang',
  'content_pivot',
  'text_translations',
  'created_at',
  'status',
  'type',
  'metadata',
  'client_message_id',
];
const COLUMN_OPTIONS = [
  { key: 'created_at', label: 'Time' },
  { key: 'ids', label: 'IDs' },
  { key: 'emails', label: 'Emails' },
  { key: 'languages', label: 'Languages' },
  { key: 'data_kind', label: 'Data' },
  { key: 'models', label: 'Models' },
  { key: 'fallback', label: 'Fallback' },
  { key: 'content', label: 'Content' },
  ...RAW_FIELD_COLUMNS.map((field) => ({ key: `field:${field}`, label: field })),
];

const DEFAULT_SETTINGS: AuditSettings = {
  advisorId: 20018,
  limit: 3,
  conversationId: '',
  createdAtFrom: '',
  createdAtTo: '',
  visibleColumns: DEFAULT_COLUMNS,
};

function formatDate(value?: string | null): string {
  return value ? new Date(value).toLocaleString() : 'unknown';
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

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : Array.isArray(value) || typeof value === 'object' ? JSON.stringify(value) : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function fieldValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

export default function LipWf1AuditPanel() {
  const [settings, setSettings] = useState<AuditSettings>(DEFAULT_SETTINGS);
  const [settingsReady, setSettingsReady] = useState(false);
  const [payload, setPayload] = useState<SupabaseLipWf1AuditResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastSavedRef = useRef('');

  async function refresh(nextSettings = settings) {
    setLoading(true);
    try {
      const next = await fetchSupabaseLipWf1Audit({
        advisor_id: nextSettings.advisorId,
        limit: nextSettings.limit,
        conversation_id: nextSettings.conversationId.trim() || undefined,
        created_at_from: nextSettings.createdAtFrom || undefined,
        created_at_to: nextSettings.createdAtTo || undefined,
      });
      setPayload(next);
      setError(null);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : 'LIP/WF1 audit failed.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    fetchConsoleDashboardSettings()
      .then((response) => {
        if (cancelled) return;
        const audit = (response.settings.supabase_monitor_audit as Partial<AuditSettings> | undefined) || {};
        const next = {
          ...DEFAULT_SETTINGS,
          ...audit,
          visibleColumns: Array.isArray(audit.visibleColumns) && audit.visibleColumns.length ? audit.visibleColumns : DEFAULT_COLUMNS,
        };
        setSettings(next);
        void refresh(next);
      })
      .catch(() => {
        void refresh(DEFAULT_SETTINGS);
      })
      .finally(() => {
        if (!cancelled) setSettingsReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!settingsReady) return;
    const serialized = JSON.stringify(settings);
    if (lastSavedRef.current === serialized) return;
    lastSavedRef.current = serialized;
    const timer = window.setTimeout(() => {
      void saveConsoleDashboardSettingsSection('supabase_monitor_audit', settings).catch(() => undefined);
    }, 500);
    return () => window.clearTimeout(timer);
  }, [settings, settingsReady]);

  function setColumn(key: string) {
    setSettings((current) => {
      const active = new Set(current.visibleColumns);
      active.has(key) ? active.delete(key) : active.add(key);
      return { ...current, visibleColumns: Array.from(active) };
    });
  }

  function hasColumn(key: string): boolean {
    return settings.visibleColumns.includes(key);
  }

  function exportPayload(format: 'json' | 'csv') {
    if (!payload) return;
    const stamp = (payload.checked_at || new Date().toISOString()).replace(/[:.]/g, '-');
    if (format === 'json') {
      downloadText(`supabase-lip-wf1-audit-${stamp}.json`, JSON.stringify(payload, null, 2), 'application/json;charset=utf-8');
      return;
    }
    const headers = ['created_at', 'message_id', 'conversation_id', 'sender_email', 'recipient_emails', 'source_lang', 'target_langs', 'data_kind', 'requested_model', 'actual_model', 'used_fallback', 'selection_reason'];
    const rows = payload.rows.map((row) => [
      row.created_at,
      row.message_id,
      row.conversation_id,
      row.sender.email,
      row.recipients.map((recipient) => recipient.email).filter(Boolean).join('; '),
      row.source_lang,
      row.target_langs.join('; '),
      row.data_kind,
      row.requested_model,
      row.actual_model,
      row.used_fallback,
      row.selection_reason,
    ]);
    downloadText(`supabase-lip-wf1-audit-${stamp}.csv`, [headers.map(csvCell).join(','), ...rows.map((row) => row.map(csvCell).join(','))].join('\n'), 'text/csv;charset=utf-8');
  }

  return (
    <section className="supabase-panel-stack">
      <div className="ops-log-filters">
        <label>
          <span>Advisor</span>
          <input min={1} type="number" value={settings.advisorId} onChange={(event) => setSettings({ ...settings, advisorId: Number(event.target.value) || 20018 })} />
        </label>
        <label>
          <span>Rows</span>
          <input max={100} min={1} type="number" value={settings.limit} onChange={(event) => setSettings({ ...settings, limit: Math.max(1, Math.min(100, Number(event.target.value) || 3)) })} />
        </label>
        <label>
          <span>Conversation</span>
          <input value={settings.conversationId} onChange={(event) => setSettings({ ...settings, conversationId: event.target.value })} placeholder="optional conversation_id" />
        </label>
        <label>
          <span>From</span>
          <input type="datetime-local" value={settings.createdAtFrom} onChange={(event) => setSettings({ ...settings, createdAtFrom: event.target.value })} />
        </label>
        <label>
          <span>To</span>
          <input type="datetime-local" value={settings.createdAtTo} onChange={(event) => setSettings({ ...settings, createdAtTo: event.target.value })} />
        </label>
      </div>

      <div className="console-section-toolbar">
        <div className="supabase-column-toggles">
          {COLUMN_OPTIONS.map((column) => (
            <label key={column.key}>
              <input checked={hasColumn(column.key)} onChange={() => setColumn(column.key)} type="checkbox" />
              <span>{column.label}</span>
            </label>
          ))}
        </div>
        <div className="ops-log-actions">
          <button className="console-icon-text-button" disabled={!payload || loading} onClick={() => exportPayload('json')} type="button">
            <Download aria-hidden="true" size={16} />
            <span>JSON</span>
          </button>
          <button className="console-icon-text-button" disabled={!payload || loading} onClick={() => exportPayload('csv')} type="button">
            <Download aria-hidden="true" size={16} />
            <span>CSV</span>
          </button>
          <button className="console-icon-text-button" disabled={loading} onClick={() => refresh()} type="button">
            <RefreshCw aria-hidden="true" className={loading ? 'spin' : undefined} size={16} />
            <span>{loading ? 'Refreshing' : 'Refresh'}</span>
          </button>
        </div>
      </div>

      {error ? <div className="console-error">{error}</div> : null}

      <div className="console-table-wrap">
        <table className="console-data-table">
          <thead>
            <tr>
              {hasColumn('created_at') ? <th>Time</th> : null}
              {hasColumn('ids') ? <th>IDs</th> : null}
              {hasColumn('emails') ? <th>Emails</th> : null}
              {hasColumn('languages') ? <th>Languages</th> : null}
              {hasColumn('data_kind') ? <th>Data</th> : null}
              {hasColumn('models') ? <th>Models</th> : null}
              {hasColumn('fallback') ? <th>Fallback</th> : null}
              {hasColumn('content') ? <th>Content</th> : null}
              {RAW_FIELD_COLUMNS.map((field) => (hasColumn(`field:${field}`) ? <th key={field}><code>{field}</code></th> : null))}
            </tr>
          </thead>
          <tbody>
            {(payload?.rows || []).map((row) => (
              <tr key={row.message_id}>
                {hasColumn('created_at') ? <td>{formatDate(row.created_at)}</td> : null}
                {hasColumn('ids') ? <td><code>{row.message_id}</code><small>{row.conversation_id}</small></td> : null}
                {hasColumn('emails') ? <td><b>{row.sender.email || row.sender.user_id}</b><small>{row.recipients.map((recipient) => recipient.email || recipient.user_id || recipient.target_lang).join(', ')}</small></td> : null}
                {hasColumn('languages') ? <td><b>{row.source_lang || 'unknown'} → {row.target_langs.join(', ') || 'unknown'}</b><small>{row.language_phase || 'unknown'}</small></td> : null}
                {hasColumn('data_kind') ? <td>{row.data_kind}</td> : null}
                {hasColumn('models') ? <td><b>{row.actual_model || 'no model'}</b><small>requested {row.requested_model || 'n/a'}</small></td> : null}
                {hasColumn('fallback') ? <td><b>{row.used_fallback === null ? 'n/a' : row.used_fallback ? 'yes' : 'no'}</b><small>{row.selection_reason || 'unknown'}</small></td> : null}
                {hasColumn('content') ? <td><b>{row.content_original || ''}</b><small>{row.content_pivot || ''}</small></td> : null}
                {RAW_FIELD_COLUMNS.map((field) => (
                  hasColumn(`field:${field}`) ? (
                    <td key={field}>
                      <pre className="supabase-field-value">{fieldValue(row.raw_fields?.[field])}</pre>
                    </td>
                  ) : null
                ))}
              </tr>
            ))}
            {payload && payload.rows.length === 0 ? (
              <tr>
                <td colSpan={settings.visibleColumns.length || 1}>No records matched these filters.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
