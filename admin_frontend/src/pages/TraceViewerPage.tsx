// FILE: ~/otmega/otmega_app/console/admin_frontend/src/pages/TraceViewerPage.tsx
// ماموریت: صفحه مشاهده traceها، timeline و مسیر اجرای روتین ها.

import AuditTable from '../components/tables/AuditTable';
import TraceWorkflowGraph from '../components/workflow/TraceWorkflowGraph';

export default function TraceViewerPage() {
  return (
    <section className="console-page">
      <div className="console-page-title">
        <h2>Trace Viewer</h2>
        <p>Visual debugging placeholder for the first read-only console milestone.</p>
      </div>
      <TraceWorkflowGraph />
      <AuditTable />
    </section>
  );
}
