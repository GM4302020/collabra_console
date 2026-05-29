// FILE: ~/otmega/otmega_app/console/admin_frontend/src/components/shell/ConsoleLoginModal.tsx
// ماموریت: نمایش popup لاگین شیشه ای Admin Console روی لایه blur قبل از دسترسی به کنسول.

import { FormEvent, useState } from 'react';

type ConsoleLoginModalProps = {
  initialError: string | null;
  loadingSession: boolean;
  loginEnabled: boolean;
  onLogin: (email: string, password: string) => Promise<void>;
};

function ConnectingDots() {
  return (
    <span className="console-connecting-label">
      <span>Connecting</span>
      <span aria-hidden="true" className="console-connecting-dots">
        <span />
        <span />
        <span />
      </span>
    </span>
  );
}

export default function ConsoleLoginModal({ initialError, loadingSession, loginEnabled, onLogin }: ConsoleLoginModalProps) {
  const [email, setEmail] = useState(() => window.localStorage.getItem('otmega_console_last_email') || '');
  const [password, setPassword] = useState('');
  const [rememberEmail, setRememberEmail] = useState(Boolean(email));
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submitLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onLogin(email, password);
      if (rememberEmail) {
        window.localStorage.setItem('otmega_console_last_email', email);
      } else {
        window.localStorage.removeItem('otmega_console_last_email');
      }
      setPassword('');
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : 'Console login failed.');
    } finally {
      setBusy(false);
    }
  }

  const disabled = busy || loadingSession || !loginEnabled;

  return (
    <div className="console-login-overlay" role="dialog" aria-modal="true" aria-labelledby="console-login-title">
      <section className="console-login-card">
        <h2 id="console-login-title">OTMEGA Admin Console</h2>
        <p>Authorized operators only</p>
        {initialError || error || !loginEnabled ? (
          <div className="console-login-error">
            {!loginEnabled ? 'Console login secrets are not configured.' : error || initialError}
          </div>
        ) : null}
        <form autoComplete="on" onSubmit={submitLogin}>
          <input
            autoComplete="username"
            disabled={disabled}
            inputMode="email"
            name="username"
            onChange={(event) => setEmail(event.target.value)}
            placeholder="admin email"
            required
            type="email"
            value={email}
          />
          <div className="console-password-field">
            <input
              autoComplete="current-password"
              disabled={disabled}
              name="password"
              onChange={(event) => setPassword(event.target.value)}
              placeholder="password"
              required
              type={showPassword ? 'text' : 'password'}
              value={password}
            />
            <button disabled={disabled} onClick={() => setShowPassword((value) => !value)} type="button">
              {showPassword ? 'Hide' : 'Show'}
            </button>
          </div>
          <label className="console-remember-row">
            <input
              checked={rememberEmail}
              disabled={disabled}
              onChange={(event) => setRememberEmail(event.target.checked)}
              type="checkbox"
            />
            <span>Remember email</span>
          </label>
          <button className="console-login-submit" disabled={disabled} type="submit">
            {busy || loadingSession ? <ConnectingDots /> : 'Login'}
          </button>
        </form>
      </section>
    </div>
  );
}
