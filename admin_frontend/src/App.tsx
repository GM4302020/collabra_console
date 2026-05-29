// FILE: ~/otmega/otmega_app/console/admin_frontend/src/App.tsx
// ماموریت: ریشه UI کنسول و اتصال shell، routeها و session اولیه.

import { useEffect, useState } from 'react';
import { fetchConfigDomains, fetchConsoleHealth, fetchConsoleSession, loginConsole, logoutConsole } from './api/consoleApi';
import type { ConfigDomain, ConsoleHealth, ConsoleSession } from './api/consoleApi';
import ConsoleLoginModal from './components/shell/ConsoleLoginModal';
import ConsoleRouter from './routes/ConsoleRouter';

export type ConsoleBootstrap = {
  health: ConsoleHealth | null;
  session: ConsoleSession | null;
  domains: ConfigDomain[];
  error: string | null;
  loading: boolean;
};

export default function App() {
  const [bootstrap, setBootstrap] = useState<ConsoleBootstrap>({
    health: null,
    session: null,
    domains: [],
    error: null,
    loading: true,
  });
  const [loginOpen, setLoginOpen] = useState(true);

  useEffect(() => {
    let alive = true;
    Promise.all([fetchConsoleHealth(), fetchConsoleSession()])
      .then(async ([health, session]) => {
        const canViewRuntime = session.capabilities.includes('console.view_runtime_inventory');
        const config = canViewRuntime ? await fetchConfigDomains() : { domains: [] };
        if (!alive) {
          return;
        }
        setBootstrap({
          health,
          session,
          domains: config.domains,
          error: null,
          loading: false,
        });
        setLoginOpen(!session.actor.authenticated);
      })
      .catch((error: Error) => {
        if (!alive) {
          return;
        }
        setBootstrap((current) => ({
          ...current,
          error: error.message,
          loading: false,
        }));
        setLoginOpen(true);
      });

    return () => {
      alive = false;
    };
  }, []);

  async function handleLogin(email: string, password: string) {
    const session = await loginConsole(email, password);
    const canViewRuntime = session.capabilities.includes('console.view_runtime_inventory');
    const config = canViewRuntime ? await fetchConfigDomains() : { domains: [] };
    setBootstrap((current) => ({
      ...current,
      domains: config.domains,
      error: null,
      session,
    }));
    setLoginOpen(false);
  }

  async function handleLogout() {
    const session = await logoutConsole();
    setBootstrap((current) => ({
      ...current,
      domains: [],
      session,
    }));
    setLoginOpen(true);
  }

  async function handleRelogin() {
    await handleLogout();
    setLoginOpen(true);
  }

  const isAuthenticated = Boolean(bootstrap.session?.actor.authenticated);

  return (
    <>
      <div className={loginOpen ? 'console-app-obscured' : ''}>
        {isAuthenticated ? (
          <ConsoleRouter bootstrap={bootstrap} onLogout={handleLogout} onRelogin={handleRelogin} />
        ) : (
          <div className="console-locked-stage" aria-hidden="true">
            <div className="console-locked-mark">OT</div>
            <strong>Admin Console</strong>
          </div>
        )}
      </div>
      {loginOpen ? (
        <ConsoleLoginModal
          initialError={bootstrap.error}
          loginEnabled={bootstrap.session?.login_enabled !== false}
          loadingSession={bootstrap.loading}
          onLogin={handleLogin}
        />
      ) : null}
    </>
  );
}
