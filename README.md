<!-- FILE: ~/otmega/otmega_app/console/README.md -->
<!-- ماموریت: معرفی ساختار Admin Console، مسیرهای deploy و قواعد توسعه دستی. -->

# OTMEGA Admin Console

This folder contains the web-only Admin Console control plane for Collabra.

- `admin_frontend/`: React/Vite/TypeScript console shell.
- `admin_backend/`: Flask/Gunicorn API and static shell host for Cloud Run.
- `admin_deploy/`: PowerShell deployment helpers.

The current milestone is production-safe and read-only. It exposes health, session, real MUPO profile lookup, runtime inventory, operational probes, Trace Viewer sandbox/workbench, and audit placeholder surfaces without database mutation, query runner, emergency controls, or writes to Collabra.

Official Cloud Run deployment from PowerShell:

```powershell
Set-Location C:\Projects\otmega\otmega_app\console\admin_deploy
.\cloudrun.deploy.ps1
```

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
|       `-- test_session.py
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
        |   `-- TraceViewerPage.tsx
        |-- routes/
        |   `-- ConsoleRouter.tsx
        `-- styles/
            `-- console.css
```

Generated or external folders intentionally omitted: `node_modules/`, `dist/`, `static_frontend/`, `__pycache__/`, `.pytest_cache/`, and `test-results/`.
