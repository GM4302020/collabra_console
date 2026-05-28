// FILE: ~/otmega/otmega_app/console/admin_frontend/src/App.tsx
// ماموریت: ریشه UI کنسول و اتصال shell، routeها و session اولیه.

import { useEffect, useState } from 'react';
import { fetchConfigDomains, fetchConsoleHealth, fetchConsoleSession, loginConsole, logoutConsole } from './api/consoleApi';
import type { ConfigDomain, ConsoleHealth, ConsoleSession } from './api/consoleApi';
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

  useEffect(() => {
    let alive = true;
    Promise.all([fetchConsoleHealth(), fetchConsoleSession(), fetchConfigDomains()])
      .then(([health, session, config]) => {
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
      });

    return () => {
      alive = false;
    };
  }, []);

  async function handleLogin(email: string, password: string) {
    const session = await loginConsole(email, password);
    setBootstrap((current) => ({
      ...current,
      error: null,
      session,
    }));
  }

  async function handleLogout() {
    const session = await logoutConsole();
    setBootstrap((current) => ({
      ...current,
      session,
    }));
  }

  return <ConsoleRouter bootstrap={bootstrap} onLogin={handleLogin} onLogout={handleLogout} />;
}
