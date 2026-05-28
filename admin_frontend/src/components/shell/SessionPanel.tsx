// FILE: ~/otmega/otmega_app/console/admin_frontend/src/components/shell/SessionPanel.tsx
// ماموریت: نمایش فرم لاگین کنسول و کارت مشخصات، آواتار، سطح دسترسی و tier کاربر واردشده.

import { FormEvent, useMemo, useState } from 'react';
import type { ConsoleSession } from '../../api/consoleApi';

type SessionPanelProps = {
  onLogin: (email: string, password: string) => Promise<void>;
  onLogout: () => Promise<void>;
  session: ConsoleSession | null;
};

function actorInitials(fullName: string | null, email: string | null): string {
  const source = fullName || email || 'OT';
  const parts = source.split(/[ .@_-]+/).filter(Boolean);
  return parts.slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || 'OT';
}

function tierStars(tier: number): string {
  const safeTier = Math.max(0, Math.min(10, Math.round(tier || 0)));
  return '★'.repeat(safeTier) || '-';
}

export default function SessionPanel({ onLogin, onLogout, session }: SessionPanelProps) {
  const actor = session?.actor;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initials = useMemo(() => actorInitials(actor?.full_name || null, actor?.email || null), [actor?.email, actor?.full_name]);

  async function submitLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onLogin(email, password);
      setPassword('');
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : 'Console login failed.');
    } finally {
      setBusy(false);
    }
  }

  async function submitLogout() {
    setBusy(true);
    setError(null);
    try {
      await onLogout();
    } catch (logoutError) {
      setError(logoutError instanceof Error ? logoutError.message : 'Console logout failed.');
    } finally {
      setBusy(false);
    }
  }

  if (actor?.authenticated) {
    return (
      <section className="console-session-card" aria-label="Console session">
        {actor.avatar_url ? (
          <img alt="" className="console-avatar" src={actor.avatar_url} />
        ) : (
          <span className="console-avatar console-avatar-fallback">{initials}</span>
        )}
        <div className="console-session-details">
          <strong>{actor.full_name || actor.email || 'Console operator'}</strong>
          <small>{actor.title || actor.email || 'Authenticated console user'}</small>
          <div className="console-session-meta">
            <span>{actor.access_level}</span>
            <span>{actor.role}</span>
            <span>Tier {actor.tier} {tierStars(actor.tier)}</span>
          </div>
        </div>
        <button className="console-quiet-button" disabled={busy} onClick={submitLogout} type="button">
          Logout
        </button>
      </section>
    );
  }

  return (
    <form className="console-login-panel" onSubmit={submitLogin}>
      <div className="console-login-fields">
        <input
          autoComplete="username"
          disabled={busy || session?.login_enabled === false}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="admin email"
          type="email"
          value={email}
        />
        <input
          autoComplete="current-password"
          disabled={busy || session?.login_enabled === false}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="password"
          type="password"
          value={password}
        />
      </div>
      <button disabled={busy || session?.login_enabled === false} type="submit">
        {busy ? 'Connecting...' : 'Login'}
      </button>
      <small>{session?.login_enabled === false ? 'Login secrets are not configured.' : error || 'No console session'}</small>
    </form>
  );
}
