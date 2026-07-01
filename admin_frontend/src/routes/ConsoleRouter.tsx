// FILE: ~/otmega/otmega_app/console/admin_frontend/src/routes/ConsoleRouter.tsx
// ماموریت: تعریف routeهای داخلی Admin Console و صفحه های read-only اولیه.

import { lazy, Suspense, useState } from 'react';
import type { ConsoleBootstrap } from '../App';
import ConsoleShell from '../components/shell/ConsoleShell';

const DashboardPage = lazy(() => import('../pages/DashboardPage'));
const FirebaseHostingPage = lazy(() => import('../pages/FirebaseHostingPage'));
const OperationalLogsPage = lazy(() => import('../pages/OperationalLogsPage'));
const RoutineTesterPage = lazy(() => import('../pages/RoutineTesterPage'));
const RuntimeSettingsPage = lazy(() => import('../pages/RuntimeSettingsPage'));
const SupabaseMonitorPage = lazy(() => import('../pages/SupabaseMonitorPage'));
const TraceViewerPage = lazy(() => import('../pages/TraceViewerPage'));
const UiTextsMatrixPage = lazy(() => import('../pages/UiTextsMatrixPage'));
const UserOperationsPage = lazy(() => import('../pages/UserOperationsPage'));

export type ConsoleTab = 'dashboard' | 'runtime' | 'users' | 'hosting' | 'logs' | 'traces' | 'uiTexts' | 'routineTester' | 'supabase';

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
    ) : activeTab === 'users' ? (
      <UserOperationsPage canRepair={Boolean(bootstrap.session?.capabilities.includes('console.repair_user_operations'))} />
    ) : activeTab === 'traces' ? (
      <TraceViewerPage />
    ) : activeTab === 'uiTexts' ? (
      <UiTextsMatrixPage />
    ) : activeTab === 'hosting' ? (
      <FirebaseHostingPage />
    ) : activeTab === 'logs' ? (
      <OperationalLogsPage />
    ) : activeTab === 'routineTester' ? (
      <RoutineTesterPage />
    ) : activeTab === 'supabase' ? (
      <SupabaseMonitorPage />
    ) : (
      <DashboardPage bootstrap={bootstrap} />
    );

  return (
    <ConsoleShell activeTab={activeTab} onLogout={onLogout} onRelogin={onRelogin} onTabChange={setActiveTab} session={bootstrap.session}>
      <Suspense fallback={<div className="console-panel console-page-loading">Loading console view...</div>}>
        {page}
      </Suspense>
    </ConsoleShell>
  );
}
