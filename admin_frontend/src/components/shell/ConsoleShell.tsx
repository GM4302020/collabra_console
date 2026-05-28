// FILE: ~/otmega/otmega_app/console/admin_frontend/src/components/shell/ConsoleShell.tsx
// ماموریت: layout اصلی کنسول شامل navigation، header و سطح دسترسی نمایشی.

import type { ReactNode } from 'react';
import type { ConsoleSession } from '../../api/consoleApi';
import type { ConsoleTab } from '../../routes/ConsoleRouter';
import SessionPanel from './SessionPanel';

type ConsoleShellProps = {
  activeTab: ConsoleTab;
  children: ReactNode;
  onLogin: (email: string, password: string) => Promise<void>;
  onLogout: () => Promise<void>;
  onTabChange: (tab: ConsoleTab) => void;
  session: ConsoleSession | null;
};

const tabs: Array<{ key: ConsoleTab; label: string }> = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'runtime', label: 'Runtime Settings' },
  { key: 'traces', label: 'Trace Viewer' },
];

export default function ConsoleShell({ activeTab, children, onLogin, onLogout, onTabChange, session }: ConsoleShellProps) {
  return (
    <div className="console-shell">
      <aside className="console-sidebar">
        <div className="console-brand">
          <span className="console-brand-mark">OT</span>
          <div>
            <strong>Admin Console</strong>
            <small>read-only bootstrap</small>
          </div>
        </div>
        <nav className="console-nav" aria-label="Console views">
          {tabs.map((tab) => (
            <button
              className={activeTab === tab.key ? 'active' : ''}
              key={tab.key}
              onClick={() => onTabChange(tab.key)}
              type="button"
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </aside>
      <main className="console-main">
        <header className="console-header">
          <div>
            <h1>console.otmega.com</h1>
            <p>Control plane shell for Collabra operational monitoring.</p>
          </div>
          <SessionPanel onLogin={onLogin} onLogout={onLogout} session={session} />
        </header>
        {children}
      </main>
    </div>
  );
}
