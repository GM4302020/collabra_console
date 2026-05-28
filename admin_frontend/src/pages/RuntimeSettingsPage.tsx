// FILE: ~/otmega/otmega_app/console/admin_frontend/src/pages/RuntimeSettingsPage.tsx
// ماموریت: صفحه مشاهده تنظیمات runtime فعلی Collabra در فاز read-only.

import type { ConfigDomain } from '../api/consoleApi';

type RuntimeSettingsPageProps = {
  domains: ConfigDomain[];
};

export default function RuntimeSettingsPage({ domains }: RuntimeSettingsPageProps) {
  return (
    <section className="console-page">
      <div className="console-page-title">
        <h2>Runtime Inventory</h2>
        <p>Current milestone lists known domains only. Editing remains disabled.</p>
      </div>
      <div className="console-table">
        <div className="console-table-row console-table-head">
          <span>Domain</span>
          <span>Source</span>
          <span>Write</span>
        </div>
        {domains.map((domain) => (
          <div className="console-table-row" key={domain.key}>
            <span>{domain.key}</span>
            <span>{domain.source}</span>
            <span>{domain.write_enabled ? 'enabled' : 'disabled'}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
