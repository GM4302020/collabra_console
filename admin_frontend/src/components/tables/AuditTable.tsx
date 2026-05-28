// FILE: ~/otmega/otmega_app/console/admin_frontend/src/components/tables/AuditTable.tsx
// ماموریت: نمایش جدول audit و trace events در فاز read-only.

export default function AuditTable() {
  return (
    <article className="console-panel console-wide-panel">
      <span className="console-label">Audit Preview</span>
      <strong>No audit events are collected in milestone 1.</strong>
      <p>Audit storage and sensitive read logging will be added after session and capability guards are stable.</p>
    </article>
  );
}
