// FILE: ~/otmega/otmega_app/console/admin_frontend/src/components/monitoring/HealthSummary.tsx
// ماموریت: نمایش خلاصه سلامت Cloud Run، backend و session کنسول.

import type { ConsoleHealth, ConsoleSession } from '../../api/consoleApi';

type HealthSummaryProps = {
  health: ConsoleHealth | null;
  loading: boolean;
  session: ConsoleSession | null;
};

export default function HealthSummary({ health, loading, session }: HealthSummaryProps) {
  return (
    <section className="console-grid">
      <article className="console-panel">
        <span className="console-label">Backend</span>
        <strong>{loading ? 'Checking' : health?.status ?? 'Unavailable'}</strong>
        <small>{health?.service ?? 'otmega-console'}</small>
      </article>
      <article className="console-panel">
        <span className="console-label">Mode</span>
        <strong>{health?.mode ?? 'read_only'}</strong>
        <small>write controls disabled</small>
      </article>
      <article className="console-panel">
        <span className="console-label">Session</span>
        <strong>{session?.actor.authenticated ? 'Authenticated' : 'Guest shell'}</strong>
        <small>{session?.actor.email ?? 'JWT not attached yet'}</small>
      </article>
    </section>
  );
}
