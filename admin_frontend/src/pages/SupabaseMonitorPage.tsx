import { useEffect, useRef, useState } from 'react';
import { fetchConsoleDashboardSettings, saveConsoleDashboardSettingsSection } from '../api/consoleApi';
import DatabaseOverviewPanel from '../components/supabase/DatabaseOverviewPanel';
import LipWf1AuditPanel from '../components/supabase/LipWf1AuditPanel';
import SupabaseStatusPanel from '../components/supabase/SupabaseStatusPanel';

const TABS = [
  { id: 'status', label: 'Status & Alerts' },
  { id: 'database', label: 'Database Overview' },
  { id: 'lip-wf1', label: 'LIP/WF1 Audit' },
] as const;

type TabId = (typeof TABS)[number]['id'];

function normalizeTab(value: unknown): TabId {
  return value === 'database' || value === 'lip-wf1' || value === 'status' ? value : 'status';
}

export default function SupabaseMonitorPage() {
  const [activeTab, setActiveTab] = useState<TabId>('status');
  const [settingsReady, setSettingsReady] = useState(false);
  const lastSavedRef = useRef('');

  useEffect(() => {
    let cancelled = false;
    fetchConsoleDashboardSettings()
      .then((response) => {
        if (cancelled) return;
        const saved = response.settings.supabase_monitor as { activeTab?: string } | undefined;
        setActiveTab(normalizeTab(saved?.activeTab));
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setSettingsReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!settingsReady) return;
    const serialized = JSON.stringify({ activeTab });
    if (lastSavedRef.current === serialized) return;
    lastSavedRef.current = serialized;
    const timer = window.setTimeout(() => {
      void saveConsoleDashboardSettingsSection('supabase_monitor', { activeTab }).catch(() => undefined);
    }, 500);
    return () => window.clearTimeout(timer);
  }, [activeTab, settingsReady]);

  return (
    <div className="console-page supabase-monitor-page">
      <div className="console-page-heading">
        <div>
          <h2>Supabase Monitor</h2>
          <p>Read-only database status, schema checks, and operational scripts.</p>
        </div>
      </div>

      <div className="routine-tester-tabs">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            className={`routine-tester-tab${activeTab === tab.id ? ' active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
            type="button"
          >
            {tab.label}
          </button>
        ))}
      </div>

      <section className="console-panel routine-tester-section">
        {activeTab === 'status' ? <SupabaseStatusPanel /> : null}
        {activeTab === 'database' ? <DatabaseOverviewPanel /> : null}
        {activeTab === 'lip-wf1' ? <LipWf1AuditPanel /> : null}
      </section>
    </div>
  );
}
