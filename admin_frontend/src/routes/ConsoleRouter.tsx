// FILE: ~/otmega/otmega_app/console/admin_frontend/src/routes/ConsoleRouter.tsx
// ماموریت: تعریف routeهای داخلی Admin Console و صفحه های read-only اولیه.

import { lazy, Suspense } from 'react';
import type { ConsoleBootstrap } from '../App';
import ConsoleShell from '../components/shell/ConsoleShell';
import { useConsolePageState } from '../hooks/useConsolePageState';

const ApkReleasesPage = lazy(() => import('../pages/ApkReleasesPage'));
const DashboardPage = lazy(() => import('../pages/DashboardPage'));
const FirebaseHostingPage = lazy(() => import('../pages/FirebaseHostingPage'));
const OperationalLogsPage = lazy(() => import('../pages/OperationalLogsPage'));
const RoutineTesterPage = lazy(() => import('../pages/RoutineTesterPage'));
const RuntimeSettingsPage = lazy(() => import('../pages/RuntimeSettingsPage'));
const SupabaseMonitorPage = lazy(() => import('../pages/SupabaseMonitorPage'));
const TraceViewerPage = lazy(() => import('../pages/TraceViewerPage'));
const UiTextsMatrixPage = lazy(() => import('../pages/UiTextsMatrixPage'));
const UserOperationsPage = lazy(() => import('../pages/UserOperationsPage'));

export type ConsoleTab = 'dashboard' | 'runtime' | 'users' | 'hosting' | 'apkReleases' | 'logs' | 'traces' | 'uiTexts' | 'routineTester' | 'supabase';

type ConsoleRouterProps = {
  bootstrap: ConsoleBootstrap;
  onLogout: () => Promise<void>;
  onRelogin: () => Promise<void>;
};

const VALID_TABS: ConsoleTab[] = ['dashboard', 'runtime', 'users', 'hosting', 'apkReleases', 'logs', 'traces', 'uiTexts', 'routineTester', 'supabase'];

export default function ConsoleRouter({ bootstrap, onLogout, onRelogin }: ConsoleRouterProps) {
  // [Request 2083] Last visited tab is part of the cloud-persisted console state, so the
  // console reopens on the page the operator was working in. Invalid values fall back
  // to the dashboard.
  const [navState, setNavState] = useConsolePageState<{ activeTab: ConsoleTab }>('console_navigation', { activeTab: 'dashboard' });
  const activeTab: ConsoleTab = VALID_TABS.includes(navState.activeTab) ? navState.activeTab : 'dashboard';
  const setActiveTab = (tab: ConsoleTab) => setNavState({ activeTab: tab });

  const page =
    activeTab === 'runtime' ? (
      <RuntimeSettingsPage domains={bootstrap.domains} />
    ) : activeTab === 'users' ? (
      <UserOperationsPage
        canManageDevLog={Boolean(bootstrap.session?.capabilities.includes('console.manage_user_devlog'))}
        canRepair={Boolean(bootstrap.session?.capabilities.includes('console.repair_user_operations'))}
      />
    ) : activeTab === 'traces' ? (
      <TraceViewerPage />
    ) : activeTab === 'uiTexts' ? (
      <UiTextsMatrixPage />
    ) : activeTab === 'hosting' ? (
      <FirebaseHostingPage />
    ) : activeTab === 'apkReleases' ? (
      <ApkReleasesPage />
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
