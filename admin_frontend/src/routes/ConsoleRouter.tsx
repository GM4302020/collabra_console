// FILE: ~/otmega/otmega_app/console/admin_frontend/src/routes/ConsoleRouter.tsx
// ماموریت: تعریف routeهای داخلی Admin Console و صفحه های read-only اولیه.

import { useState } from 'react';
import type { ConsoleBootstrap } from '../App';
import ConsoleShell from '../components/shell/ConsoleShell';
import DashboardPage from '../pages/DashboardPage';
import RuntimeSettingsPage from '../pages/RuntimeSettingsPage';
import TraceViewerPage from '../pages/TraceViewerPage';

export type ConsoleTab = 'dashboard' | 'runtime' | 'traces';

type ConsoleRouterProps = {
  bootstrap: ConsoleBootstrap;
  onLogin: (email: string, password: string) => Promise<void>;
  onLogout: () => Promise<void>;
};

export default function ConsoleRouter({ bootstrap, onLogin, onLogout }: ConsoleRouterProps) {
  const [activeTab, setActiveTab] = useState<ConsoleTab>('dashboard');

  const page =
    activeTab === 'runtime' ? (
      <RuntimeSettingsPage domains={bootstrap.domains} />
    ) : activeTab === 'traces' ? (
      <TraceViewerPage />
    ) : (
      <DashboardPage bootstrap={bootstrap} />
    );

  return (
    <ConsoleShell activeTab={activeTab} onLogin={onLogin} onLogout={onLogout} onTabChange={setActiveTab} session={bootstrap.session}>
      {page}
    </ConsoleShell>
  );
}
