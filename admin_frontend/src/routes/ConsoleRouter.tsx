// FILE: ~/otmega/otmega_app/console/admin_frontend/src/routes/ConsoleRouter.tsx
// ماموریت: تعریف routeهای داخلی Admin Console و صفحه های read-only اولیه.

import { useState } from 'react';
import type { ConsoleBootstrap } from '../App';
import ConsoleShell from '../components/shell/ConsoleShell';
import DashboardPage from '../pages/DashboardPage';
import RuntimeSettingsPage from '../pages/RuntimeSettingsPage';
import TraceViewerPage from '../pages/TraceViewerPage';
import UiTextsMatrixPage from '../pages/UiTextsMatrixPage';

export type ConsoleTab = 'dashboard' | 'runtime' | 'traces' | 'uiTexts';

type ConsoleRouterProps = {
  bootstrap: ConsoleBootstrap;
  onLogout: () => Promise<void>;
  onRelogin: () => Promise<void>;
};

export default function ConsoleRouter({ bootstrap, onLogout, onRelogin }: ConsoleRouterProps) {
  const [activeTab, setActiveTab] = useState<ConsoleTab>('dashboard');

  const page =
    activeTab === 'runtime' ? (
      <RuntimeSettingsPage domains={bootstrap.domains} />
    ) : activeTab === 'traces' ? (
      <TraceViewerPage />
    ) : activeTab === 'uiTexts' ? (
      <UiTextsMatrixPage />
    ) : (
      <DashboardPage bootstrap={bootstrap} />
    );

  return (
    <ConsoleShell activeTab={activeTab} onLogout={onLogout} onRelogin={onRelogin} onTabChange={setActiveTab} session={bootstrap.session}>
      {page}
    </ConsoleShell>
  );
}
