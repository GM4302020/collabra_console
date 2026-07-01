// FILE: ~/otmega/otmega_app/console/admin_frontend/src/pages/RoutineTesterPage.tsx
// ماموریت: صفحه تست مستقل روتین‌های برنامه — تب GCS File Browser و Live ASR Streaming.

import { useState } from 'react';
import GcsBrowserPanel from '../components/gcs/GcsBrowserPanel';
import LiveAsrPanel from '../components/live-asr/LiveAsrPanel';
import LiveTranslatePanel from '../components/live-translate/LiveTranslatePanel';

const TABS = [
  { id: 'gcs', label: 'GCS File Browser' },
  { id: 'live-asr', label: 'Live ASR Streaming' },
  { id: 'live-translate', label: 'Live Translate' },
] as const;

type TabId = (typeof TABS)[number]['id'];

export default function RoutineTesterPage() {
  const [activeTab, setActiveTab] = useState<TabId>('gcs');

  return (
    <div className="console-page routine-tester-page">
      <div className="console-page-heading">
        <div>
          <h2>Routine Tester</h2>
          <p>Standalone test workspace for application routines.</p>
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

      {activeTab === 'gcs' && (
        <section className="console-panel routine-tester-section">
          <GcsBrowserPanel />
        </section>
      )}

      {activeTab === 'live-asr' && (
        <section className="console-panel routine-tester-section">
          <LiveAsrPanel />
        </section>
      )}

      {activeTab === 'live-translate' && (
        <section className="console-panel routine-tester-section">
          <LiveTranslatePanel />
        </section>
      )}
    </div>
  );
}
