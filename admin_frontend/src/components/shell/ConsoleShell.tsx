// FILE: ~/otmega/otmega_app/console/admin_frontend/src/components/shell/ConsoleShell.tsx
// ماموریت: layout اصلی کنسول شامل navigation، header و سطح دسترسی نمایشی.

import {
  Activity,
  ChevronLeft,
  ChevronRight,
  FlaskConical,
  GitBranch,
  LayoutDashboard,
  Monitor,
  Moon,
  Settings,
  SlidersHorizontal,
  Sun,
  TableProperties,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import type { ConsoleSession } from '../../api/consoleApi';
import type { ConsoleTab } from '../../routes/ConsoleRouter';
import SessionPanel from './SessionPanel';

type ConsoleShellProps = {
  activeTab: ConsoleTab;
  children: ReactNode;
  onLogout: () => Promise<void>;
  onRelogin: () => Promise<void>;
  onTabChange: (tab: ConsoleTab) => void;
  session: ConsoleSession | null;
};

type ThemeChoice = 'light' | 'dark' | 'system';

const SIDEBAR_MIN = 72;
const SIDEBAR_DEFAULT = 284;
const SIDEBAR_MAX = 420;
const SIDEBAR_COLLAPSED_MAX = 104;

const tabs: Array<{ key: ConsoleTab; label: string; icon: LucideIcon }> = [
  { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { key: 'runtime', label: 'Runtime Settings', icon: SlidersHorizontal },
  { key: 'uiTexts', label: 'UI Texts Matrix', icon: TableProperties },
  { key: 'traces', label: 'Trace Viewer', icon: GitBranch },
  { key: 'routineTester', label: 'Routine Tester', icon: FlaskConical },
];

const themeOptions: Array<{ key: ThemeChoice; label: string; icon: LucideIcon }> = [
  { key: 'light', label: 'Light', icon: Sun },
  { key: 'dark', label: 'Dark', icon: Moon },
  { key: 'system', label: 'System', icon: Monitor },
];

const statusColors: Record<string, string> = {
  online: '#2ecc71',
  busy: '#e74c3c',
  away: '#f1c40f',
  offline: '#95a5a6',
  blocked: '#2c3e50',
};

function actorInitials(fullName?: string | null, email?: string | null): string {
  const source = fullName || email || 'OT';
  const parts = source.split(/[ .@_-]+/).filter(Boolean);
  return parts.slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || 'OT';
}

function renderStars(tier?: number): string {
  const filled = Math.max(0, Math.min(5, Math.round(tier || 0)));
  return `${'★'.repeat(filled)}${'☆'.repeat(5 - filled)}`;
}

export default function ConsoleShell({ activeTab, children, onLogout, onRelogin, onTabChange, session }: ConsoleShellProps) {
  const actor = session?.actor;
  const isAuthenticated = Boolean(actor?.authenticated);
  const ringColor = statusColors[actor?.online_status || 'offline'] || statusColors.offline;
  const [mupoOpen, setMupoOpen] = useState(false);
  const [avatarFailed, setAvatarFailed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const stored = Number(window.localStorage.getItem('otmega.console.sidebarWidth'));
    return Number.isFinite(stored) && stored >= SIDEBAR_MIN ? stored : SIDEBAR_DEFAULT;
  });
  const [themeChoice, setThemeChoice] = useState<ThemeChoice>(() => {
    const stored = window.localStorage.getItem('otmega.console.theme') as ThemeChoice | null;
    return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
  });
  const collapsed = sidebarWidth <= SIDEBAR_COLLAPSED_MAX;

  useEffect(() => {
    const applyTheme = () => {
      const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.dataset.theme = themeChoice === 'system' ? (systemDark ? 'dark' : 'light') : themeChoice;
      document.documentElement.dataset.themeChoice = themeChoice;
    };
    applyTheme();
    window.localStorage.setItem('otmega.console.theme', themeChoice);
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', applyTheme);
    return () => media.removeEventListener('change', applyTheme);
  }, [themeChoice]);

  useEffect(() => {
    window.localStorage.setItem('otmega.console.sidebarWidth', String(sidebarWidth));
  }, [sidebarWidth]);

  const shellStyle = useMemo(
    () => ({ '--console-sidebar-width': `${sidebarWidth}px` }) as CSSProperties,
    [sidebarWidth],
  );

  function beginSidebarResize(event: React.MouseEvent<HTMLDivElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    document.body.classList.add('console-resizing');

    function handleMove(moveEvent: MouseEvent) {
      const nextWidth = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, startWidth + moveEvent.clientX - startX));
      setSidebarWidth(nextWidth);
    }

    function handleUp() {
      document.body.classList.remove('console-resizing');
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    }

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
  }

  function toggleSidebarWidth() {
    setSidebarWidth((current) => (current <= SIDEBAR_COLLAPSED_MAX ? SIDEBAR_DEFAULT : SIDEBAR_MIN));
  }

  return (
    <div className={`console-shell ${collapsed ? 'sidebar-collapsed' : ''}`} style={shellStyle}>
      <aside className="console-sidebar" aria-label="Admin Console sidebar">
        <div className="console-brand">
          <button
            aria-expanded={mupoOpen}
            className="console-mupo-trigger"
            onClick={() => setMupoOpen((value) => !value)}
            title="MUPO"
            type="button"
          >
            <span className="console-mupo-avatar" style={{ borderColor: ringColor }}>
              {isAuthenticated && actor?.avatar_url && !avatarFailed ? (
                <img alt="" onError={() => setAvatarFailed(true)} src={actor.avatar_url} />
              ) : (
                <span>{actorInitials(actor?.full_name, actor?.email)}</span>
              )}
            </span>
          </button>
          <div className="console-brand-copy">
            <strong>Admin Console</strong>
            <small>read-only control plane</small>
          </div>
          <button className="console-sidebar-toggle" onClick={toggleSidebarWidth} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} type="button">
            {collapsed ? <ChevronRight aria-hidden="true" size={18} /> : <ChevronLeft aria-hidden="true" size={18} />}
          </button>
          {isAuthenticated && mupoOpen ? (
            <div className="console-mupo-popover">
              <div className="console-mupo-row console-mupo-role">
                <span>{actor?.access_level}</span>
                <span>:</span>
                <strong>{actor?.full_name || actor?.email}</strong>
              </div>
              <small>{actor?.email}</small>
              <div className="console-mupo-row console-mupo-coin">
                  <span>{actor?.balance || '0.00'}</span>
                  <span>Φ</span>
              </div>
              <div className="console-mupo-row console-mupo-stars">{renderStars(actor?.tier)}</div>
              <div className="console-mupo-row console-mupo-status">
                <span>{actor?.online_status}</span>
                <span>{actor?.country_code}</span>
              </div>
            </div>
          ) : null}
        </div>
        <hr aria-hidden="true" className="console-sidebar-divider" />
        <nav className="console-nav" aria-label="Console views">
          {tabs.map((tab) => {
            const TabIcon = tab.icon;
            return (
              <button
                className={activeTab === tab.key ? 'active' : ''}
                key={tab.key}
                onClick={() => onTabChange(tab.key)}
                title={tab.label}
                type="button"
              >
                <TabIcon aria-hidden="true" size={19} />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="console-sidebar-bottom">
          <section className="console-theme-switcher" aria-label="Theme settings">
            <div className="console-sidebar-section-title">
              <Settings aria-hidden="true" size={16} />
              <span>Settings</span>
            </div>
            <div className="console-theme-buttons">
              {themeOptions.map((option) => (
                <button
                  aria-pressed={themeChoice === option.key}
                  className={themeChoice === option.key ? 'active' : ''}
                  key={option.key}
                  onClick={() => setThemeChoice(option.key)}
                  title={`${option.label} theme`}
                  type="button"
                >
                  <option.icon aria-hidden="true" size={16} />
                  <span>{option.label}</span>
                </button>
              ))}
            </div>
          </section>
          <SessionPanel collapsed={collapsed} onLogout={onLogout} onRelogin={onRelogin} session={session} />
        </div>
        <div aria-hidden="true" className="console-sidebar-resizer" onMouseDown={beginSidebarResize} />
      </aside>
      <main className="console-main">
        <header className="console-header">
          <div className="console-header-title">
            <h1>console.otmega.com</h1>
            <p>Control plane shell for Collabra operational monitoring.</p>
          </div>
          <div className="console-header-status">
            <Activity aria-hidden="true" size={17} />
            <span>Live probes refresh every 30s</span>
          </div>
        </header>
        <section className="console-content" aria-label="Console workspace">
          {children}
        </section>
        <footer className="console-footer">
          <span>Read-only control plane</span>
          <span>{actor?.email || 'No active actor'}</span>
          <span>{actor?.advisor_id ? `advisor ${actor.advisor_id}` : 'advisor pending'}</span>
        </footer>
      </main>
    </div>
  );
}
