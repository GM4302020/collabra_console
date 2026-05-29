// FILE: ~/otmega/otmega_app/console/admin_frontend/src/pages/DashboardPage.tsx
// ماموریت: صفحه داشبورد اولیه برای health، session و وضعیت read-only کنسول.

import type { ConsoleBootstrap } from '../App';
import HealthSummary from '../components/monitoring/HealthSummary';
import OperationalResources from '../components/monitoring/OperationalResources';

type DashboardPageProps = {
  bootstrap: ConsoleBootstrap;
};

export default function DashboardPage({ bootstrap }: DashboardPageProps) {
  return (
    <section className="console-page">
      <div className="console-page-title">
        <h2>Operational Snapshot</h2>
        <p>First milestone: visible Cloud Run shell, health API, session API, no write controls.</p>
      </div>
      {bootstrap.error ? <div className="console-error">{bootstrap.error}</div> : null}
      <HealthSummary health={bootstrap.health} loading={bootstrap.loading} session={bootstrap.session} />
      <OperationalResources enabled={Boolean(bootstrap.session?.capabilities.includes('console.view_operational_status'))} />
      <article className="console-panel console-wide-panel">
        <span className="console-label">Guardrail</span>
        <strong>Read-only mode is enforced for milestone 1.</strong>
        <p>No database mutation, emergency switch, query runner, or user control is active in this build.</p>
      </article>
    </section>
  );
}
