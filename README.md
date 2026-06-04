<!-- FILE: ~/otmega/otmega_app/console/README.md -->
<!-- ماموریت: معرفی ساختار Admin Console، مسیرهای deploy و قواعد توسعه دستی. -->

# OTMEGA Admin Console

This folder contains the web-only Admin Console control plane for Collabra.

- `admin_frontend/`: React/Vite/TypeScript console shell.
- `admin_backend/`: Flask/Gunicorn API and static shell host for Cloud Run.
- `admin_deploy/`: PowerShell deployment helpers.

The current milestone is production-safe with tightly scoped User Zero writes for the UI Texts Matrix. It exposes health, session, real MUPO profile lookup, runtime inventory, operational probes, Trace Viewer sandbox/workbench, audit placeholder surfaces, AI-assisted UI text suggestions, manual SQL/Python exports, and controlled direct apply for UI text language payloads.

Official Cloud Run deployment from PowerShell. This is the supported validation path for the console; do not use a local dev server for acceptance checks.

```powershell
Set-Location C:\Projects\otmega\otmega_app\console\admin_deploy
.\cloudrun.deploy.ps1
```

The deploy script verifies the active `gcloud` account, required Secret Manager entries, frontend production build, backend tests, backend Python compilation, and the attached `static_frontend/index.html` before publishing Cloud Run.

UI Texts Matrix direct apply:

- Button: `Apply DB + Python files`
- Capability: `console.apply_ui_texts_matrix`, available only to User Zero.
- Behavior: confirms the operation, writes final `.py` files to the configured UI texts path, updates `config_domain_registry` for changed languages through the backend service role, then reloads the matrix from the runtime source.
- Manual exports remain available through `Generate SQL/Python patch` and `Generate final .py files`.

Source structure, excluding generated folders and build artifacts:

```text
console/
|-- .gitignore
|-- README.md
|-- tree.txt
|-- admin_backend/
|   |-- Dockerfile
|   |-- app.py
|   |-- requirements.txt
|   |-- admin_api/
|   |   |-- __init__.py
|   |   |-- audit_routes.py
|   |   |-- auth.py
|   |   |-- capabilities.py
|   |   |-- config_routes.py
|   |   |-- guards.py
|   |   |-- health_routes.py
|   |   |-- operational_routes.py
|   |   |-- profile_adapter.py
|   |   |-- session_routes.py
|   |   |-- static_routes.py
|   |   `-- trace_routes.py
|   `-- tests/
|       |-- test_health.py
|       |-- test_session.py
|       `-- test_ui_texts_matrix.py
|-- admin_deploy/
|   |-- cloudrun.deploy.ps1
|   `-- firebase-hosting.deploy.ps1
`-- admin_frontend/
    |-- index.html
    |-- package.json
    |-- tsconfig.json
    |-- vite.config.ts
    |-- public/
    |   `-- favicon.svg
    `-- src/
        |-- App.tsx
        |-- main.tsx
        |-- api/
        |   |-- consoleApi.ts
        |   `-- traceStream.ts
        |-- components/
        |   |-- monitoring/
        |   |   |-- HealthSummary.tsx
        |   |   `-- OperationalResources.tsx
        |   |-- shell/
        |   |   |-- ConsoleLoginModal.tsx
        |   |   |-- ConsoleShell.tsx
        |   |   `-- SessionPanel.tsx
        |   |-- tables/
        |   |   `-- AuditTable.tsx
        |   `-- workflow/
        |       `-- TraceWorkflowGraph.tsx
        |-- pages/
        |   |-- DashboardPage.tsx
        |   |-- RuntimeSettingsPage.tsx
        |   |-- TraceViewerPage.tsx
        |   `-- UiTextsMatrixPage.tsx
        |-- routes/
        |   `-- ConsoleRouter.tsx
        `-- styles/
            `-- console.css
```

Generated or external folders intentionally omitted: `node_modules/`, `dist/`, `static_frontend/`, `__pycache__/`, `.pytest_cache/`, and `test-results/`.
