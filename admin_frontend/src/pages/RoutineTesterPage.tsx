// FILE: ~/otmega/otmega_app/console/admin_frontend/src/pages/RoutineTesterPage.tsx
// ماموریت: صفحه تست مستقل روتین‌های برنامه با GCS File Browser به‌عنوان اولین ابزار.

import GcsBrowserPanel from '../components/gcs/GcsBrowserPanel';

export default function RoutineTesterPage() {
  return (
    <div className="console-page routine-tester-page">
      <div className="console-page-heading">
        <div>
          <h2>Routine Tester</h2>
          <p>Standalone test workspace for application routines. Browse GCS files for audio playback and image preview.</p>
        </div>
      </div>

      <section className="console-panel routine-tester-section">
        <h3 className="routine-tester-section-title">GCS File Browser</h3>
        <GcsBrowserPanel />
      </section>
    </div>
  );
}
