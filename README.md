<!-- FILE: ~/otmega/otmega_app/console/README.md -->
<!-- ماموریت: معرفی ساختار Admin Console، مسیرهای deploy و قواعد توسعه دستی. -->

# OTMEGA Admin Console

This folder contains the web-only Admin Console control plane for Collabra.

- `admin_frontend/`: React/Vite/TypeScript console shell.
- `admin_backend/`: Flask/Gunicorn API and static shell host for Cloud Run.
- `admin_deploy/`: PowerShell deployment helpers.

The current milestone is production-safe with tightly scoped User Zero writes for the UI Texts Matrix. It exposes health, session, real MUPO profile lookup, runtime inventory, operational probes, Supabase Monitor, Routine Tester Live Translate, Trace Viewer sandbox/workbench, audit placeholder surfaces, AI-assisted UI text suggestions, manual SQL/Python exports, and controlled direct apply for UI text language payloads.

Supabase Monitor:

- Menu: `Supabase Monitor`
- Capability: `console.view_supabase_monitor`
- Backend routes: `GET /api/console/supabase/status`, `GET /api/console/supabase/database-overview`, `GET /api/console/supabase/lip-wf1-audit`
- Behavior: read-only status/overview/audit surface; no database write, repair, migration, or DDL.
- UI settings: saved through the existing dashboard settings file at `advisors/collabra-20018-v1.0.0/main-data/admin-console-dashboard-settings.json`.

Routine Tester Live Translate:

- Menu: `Routine Tester` → tab `Live Translate`
- Capability: `console.use_live_translate`
- Backend routes: `GET /api/console/live-translate/config`, `POST /api/console/live-translate/session-token`, `POST /api/console/live-translate/save-session`
- Behavior: browser microphone streams PCM audio to Gemini Live API with an ephemeral token issued by console backend; input/output transcripts and source/target WAV files can be saved to GCS.
- Runtime controls: target language list follows the official 70+ Live Translate languages; chunk duration, stop drain, VAD sensitivity, silence, prefix padding, activity handling, turn coverage, transcript toggles, target language, and echo mode are adjustable in the tab and persisted in browser settings. `Default settings` restores the current baseline values.
- Target language picker: languages are displayed in English alphabetical order; search typing filters/jumps the list while keeping the select list available. The last manually selected target language is persisted and is not overwritten by refresh or saved-session restore.
- Settings profiles: current runtime settings can be saved/loaded as `General`, `iOS`, `Android`, `Windows`, `macOS`, `Linux`, or `Other OS`; saved sessions include the profile key/label when a stored profile was active.
- Workspace restore: the tab persists its last session id, active profile, and runtime settings in the shared dashboard settings section `live_translate`; saved-session audio can play from signed URLs or inline base64 fallback.
- Waiting/cost UI: token/setup/drain/save/load states show spinner, timer, and color pulse; usage metadata is converted into token and duration cost estimates using the current Google paid-tier Live Translate prices.
- WebSocket diagnostics: saved sessions include `frontend_log.json` and `backend_log.json`; the UI shows queued/sent/server-message counts and can decode string/blob/array-buffer server payloads.
- GCS save prefix: `advisors/collabra-20018-v1.0.0/main-data/live-translate-sessions/`.
- External dependency: `GEMINI_API_KEY_25` or `GEMINI_API_KEY` with access to `gemini-3.5-live-translate-preview`.

Official Cloud Run deployment from PowerShell. This is the supported validation path for the console; do not use a local dev server for acceptance checks.

```powershell
Set-Location C:\Projects\otmega\otmega_app\console\admin_deploy
.\console.deploy.ps1
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
|   |   |-- live_translate_routes.py
|   |   |-- operational_routes.py
|   |   |-- profile_adapter.py
|   |   |-- session_routes.py
|   |   |-- static_routes.py
|   |   |-- supabase_monitor_routes.py
|   |   |-- svlip_prefs_routes.py
|   |   `-- trace_routes.py
|   `-- tests/
|       |-- test_health.py
|       |-- test_session.py
|       `-- test_ui_texts_matrix.py
|-- admin_deploy/
|   |-- console.deploy.ps1
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
        |   |-- live-translate/
        |   |   |-- LiveTranslatePanel.tsx
        |   |   `-- liveTranslateAudio.ts
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
        |   |-- SupabaseMonitorPage.tsx
        |   |-- TraceViewerPage.tsx
        |   `-- UiTextsMatrixPage.tsx
        |-- routes/
        |   `-- ConsoleRouter.tsx
        `-- styles/
            `-- console.css
```

Generated or external folders intentionally omitted: `node_modules/`, `dist/`, `static_frontend/`, `__pycache__/`, `.pytest_cache/`, and `test-results/`.
