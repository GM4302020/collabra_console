// FILE: ~/otmega/otmega_app/console/admin_frontend/src/components/shell/SessionPanel.tsx
// ماموریت: نمایش اکشن های session مثل relogin و logout در پایین sidebar کنسول.

import { useState } from 'react';
import { LogOut, RefreshCw } from 'lucide-react';
import type { ConsoleSession } from '../../api/consoleApi';

type SessionPanelProps = {
  collapsed: boolean;
  onLogout: () => Promise<void>;
  onRelogin: () => Promise<void>;
  session: ConsoleSession | null;
};

export default function SessionPanel({ collapsed, onLogout, onRelogin, session }: SessionPanelProps) {
  const actor = session?.actor;
  const [busy, setBusy] = useState(false);

  async function submitLogout() {
    setBusy(true);
    try {
      await onLogout();
    } finally {
      setBusy(false);
    }
  }

  async function submitRelogin() {
    setBusy(true);
    try {
      await onRelogin();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="console-sidebar-session" aria-label="Console session actions">
      <small title={actor?.email || 'No console session'}>{actor?.email || 'No console session'}</small>
      <button disabled={busy} onClick={submitRelogin} title="Re-login" type="button">
        <RefreshCw aria-hidden="true" size={17} />
        <span>{collapsed ? '' : 'Re-login'}</span>
      </button>
      <button disabled={busy} onClick={submitLogout} title="Logout" type="button">
        <LogOut aria-hidden="true" size={17} />
        <span>{collapsed ? '' : 'Logout'}</span>
      </button>
    </section>
  );
}
