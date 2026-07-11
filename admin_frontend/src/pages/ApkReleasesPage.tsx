// FILE: ~/otmega/otmega_app/console/admin_frontend/src/pages/ApkReleasesPage.tsx
// ماموریت: APK Release Center — ویزارد گام‌به‌گام انتشار نسخه جدید (هر گام تا تایید گام قبل
// قفل است؛ دستورهای لوکال copy-paste آماده با مسیر ریپوی قابل تنظیم) + رجیستر نسخه‌ها با
// مشخصات و فعال‌سازی/برگشت یک‌کلیکی. درخواست 2082 سند 0016-0201.
// ساخت/امضای APK همیشه لوکال است؛ کنسول فقط ثبت، انتشار و verify را انجام می‌دهد.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CheckCircle2, ClipboardCopy, Lock, RefreshCw, Rocket, ShieldCheck, UploadCloud } from 'lucide-react';
import {
  activateApkRelease,
  fetchApkReleases,
  uploadApkRelease,
  verifyApkRelease,
  type ApkRelease,
  type ApkReleasesResponse,
  type ApkReleaseVerifyResponse,
} from '../api/consoleApi';
import { useConsolePageState } from '../hooks/useConsolePageState';

const WIZARD_STORAGE_KEY = 'otmega.console.apkReleaseWizard.v1';
const DEFAULT_REPO_PATH = 'C:\\Projects\\otmega\\otmega_app';

type WizardManualState = {
  repoPath: string;
  versionName: string;
  versionCode: string;
  bumpDone: boolean;
  buildDone: boolean;
  backendState: 'pending' | 'done' | 'skipped';
};

const DEFAULT_WIZARD_STATE: WizardManualState = {
  repoPath: DEFAULT_REPO_PATH,
  versionName: '',
  versionCode: '',
  bumpDone: false,
  buildDone: false,
  backendState: 'pending',
};

function loadWizardState(): WizardManualState {
  try {
    const raw = window.localStorage.getItem(WIZARD_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_WIZARD_STATE };
    return { ...DEFAULT_WIZARD_STATE, ...(JSON.parse(raw) as Partial<WizardManualState>) };
  } catch {
    return { ...DEFAULT_WIZARD_STATE };
  }
}

function formatBytes(size: number | null): string {
  if (!size || size <= 0) return 'unknown';
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return 'unknown';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function CommandBlock({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ position: 'relative', marginTop: '6px' }}>
      <pre
        style={{
          background: 'rgba(15,23,42,0.85)',
          color: '#e2e8f0',
          padding: '10px 12px',
          borderRadius: '8px',
          fontSize: '0.82em',
          overflowX: 'auto',
          whiteSpace: 'pre',
        }}
      >
        {command}
      </pre>
      <button
        className="console-icon-text-button"
        onClick={() => {
          void navigator.clipboard.writeText(command).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
        style={{ position: 'absolute', top: '6px', right: '6px' }}
        type="button"
      >
        <ClipboardCopy aria-hidden="true" size={14} />
        <span>{copied ? 'Copied!' : 'Copy'}</span>
      </button>
    </div>
  );
}

type WizardStepProps = {
  index: number;
  title: string;
  done: boolean;
  locked: boolean;
  children: ReactNode;
};

function WizardStep({ index, title, done, locked, children }: WizardStepProps) {
  return (
    <article
      className="console-panel"
      style={{
        opacity: locked ? 0.55 : 1,
        borderColor: done ? '#22c55e' : undefined,
        marginTop: '10px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <strong>
          {index}. {title}
        </strong>
        {done ? (
          <span style={{ color: '#22c55e', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
            <CheckCircle2 aria-hidden="true" size={15} /> done
          </span>
        ) : locked ? (
          <span style={{ color: '#94a3b8', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
            <Lock aria-hidden="true" size={13} /> complete the previous step first
          </span>
        ) : null}
      </div>
      {locked ? null : <div style={{ marginTop: '6px' }}>{children}</div>}
    </article>
  );
}

export default function ApkReleasesPage() {
  const [payload, setPayload] = useState<ApkReleasesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // [Request 2083] Wizard state lives in the cloud console settings (per-actor section),
  // so returning to this page — from any browser — restores the last state. The old
  // localStorage value seeds the defaults once for a smooth migration.
  const [wizard, setWizard] = useConsolePageState<WizardManualState>('apk_releases_wizard', loadWizardState());
  const [changelog, setChangelog] = useState('');
  const [uploading, setUploading] = useState(false);
  const [activatingId, setActivatingId] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<ApkReleaseVerifyResponse | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  async function refreshReleases() {
    setLoading(true);
    try {
      const nextPayload = await fetchApkReleases();
      setPayload(nextPayload);
      setError(null);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : 'APK release registry read failed.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refreshReleases();
  }, []);

  const repo = wizard.repoPath.replace(/[\\/]+$/, '') || DEFAULT_REPO_PATH;
  const versionNameValid = /^[0-9]+\.[0-9]+\.[0-9]+$/.test(wizard.versionName.trim());
  const versionCodeValid = /^[0-9]+$/.test(wizard.versionCode.trim());
  const setupDone = versionNameValid && versionCodeValid && repo.length > 3;
  const wizardReleaseId = setupDone ? `v${wizard.versionName.trim()}-build-${wizard.versionCode.trim()}` : '';

  const releases = payload?.releases ?? [];
  const activeRelease = releases.find((release) => release.release_id === payload?.active_release_id) ?? null;
  const uploadDone = Boolean(wizardReleaseId) && releases.some((release) => release.release_id === wizardReleaseId);
  const activateDone = Boolean(wizardReleaseId) && payload?.active_release_id === wizardReleaseId;
  const backendDone = wizard.backendState !== 'pending';
  const verifyDone = Boolean(verifyResult?.all_ok) && activateDone;

  const buildCommand = useMemo(
    () => [
      `cd ${repo}\\frontend_hybrid`,
      'npm run build',
      'firebase deploy --only hosting',
      'npx cap sync',
      'cd android',
      './gradlew assembleRelease',
      'cd ..',
    ].join('\n'),
    [repo],
  );
  const backendCommand = useMemo(() => [`cd ${repo}\\backend`, '.\\collabra_backend.ps1'].join('\n'), [repo]);
  const apkOutputPath = `${repo}\\frontend_hybrid\\android\\app\\build\\outputs\\apk\\release\\app-release.apk`;

  async function handleWizardUpload() {
    const file = fileInputRef.current?.files?.[0] ?? null;
    setNotice(null);
    if (!file) {
      setError(`Choose the signed APK first (expected at: ${apkOutputPath}).`);
      return;
    }
    if (!changelog.trim()) {
      setError('Changelog is required for the release record.');
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const result = await uploadApkRelease({
        file,
        versionName: wizard.versionName.trim(),
        versionCode: Number(wizard.versionCode.trim()),
        changelog: changelog.trim(),
      });
      setPayload(result);
      setNotice(`Uploaded ${result.release?.release_id ?? 'release'} to GCS. Continue with Activate.`);
      setChangelog('');
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : 'APK upload failed.');
    } finally {
      setUploading(false);
    }
  }

  async function handleActivate(releaseId: string) {
    const confirmed = window.confirm(
      `Activate ${releaseId}?\n\nThe website stable download link will immediately serve this APK.`,
    );
    if (!confirmed) return;
    setActivatingId(releaseId);
    setNotice(null);
    setError(null);
    try {
      const result = await activateApkRelease(releaseId);
      setPayload(result);
      setVerifyResult(null);
      setNotice(`${releaseId} is now the active public release.`);
    } catch (activateError) {
      setError(activateError instanceof Error ? activateError.message : 'APK release activation failed.');
    } finally {
      setActivatingId(null);
    }
  }

  async function handleVerify() {
    setVerifying(true);
    setError(null);
    try {
      const result = await verifyApkRelease();
      setVerifyResult(result);
    } catch (verifyError) {
      setError(verifyError instanceof Error ? verifyError.message : 'Release verification failed.');
    } finally {
      setVerifying(false);
    }
  }

  function resetWizard() {
    if (!window.confirm('Reset the wizard progress (registry and releases stay untouched)?')) return;
    setWizard((previous) => ({
      ...DEFAULT_WIZARD_STATE,
      repoPath: previous.repoPath,
    }));
    setVerifyResult(null);
    setChangelog('');
  }

  return (
    <section className="console-page">
      <div className="console-page-heading">
        <div>
          <h2>APK Releases</h2>
          <p>Guided release wizard + version registry for the Collabra Android APK. Build and signing stay on your machine.</p>
        </div>
        <div className="firebase-release-actions">
          <button className="console-icon-text-button" onClick={resetWizard} type="button">
            <RefreshCw aria-hidden="true" size={17} />
            <span>Reset wizard</span>
          </button>
          <button className="console-icon-text-button" disabled={loading} onClick={refreshReleases} type="button">
            <RefreshCw aria-hidden="true" className={loading ? 'spin' : undefined} size={17} />
            <span>{loading ? 'Refreshing' : 'Refresh'}</span>
          </button>
        </div>
      </div>

      {error ? <div className="console-error">{error}</div> : null}
      {notice ? <div className="console-panel" style={{ borderColor: '#22c55e' }}>{notice}</div> : null}

      <div className="firebase-release-summary">
        <article className="console-panel">
          <span className="console-label">Active Release</span>
          <strong>{activeRelease ? activeRelease.release_id : loading ? 'loading' : 'none'}</strong>
          <p>{activeRelease ? `${formatBytes(activeRelease.size_bytes)} — ${activeRelease.released_at}` : 'No active release registered.'}</p>
        </article>
        <article className="console-panel">
          <span className="console-label">Stable Download URL</span>
          <strong style={{ wordBreak: 'break-all', fontSize: '0.85em' }}>{payload?.stable_download_url ?? '—'}</strong>
          <p>The website button points here; Activate switches it with no deploy.</p>
        </article>
        <article className="console-panel">
          <span className="console-label">Storage</span>
          <strong>{payload?.bucket ?? '—'}</strong>
          <p style={{ wordBreak: 'break-all' }}>{payload?.base_path ?? ''}</p>
        </article>
      </div>

      {/* ------------------------- Release Wizard ------------------------- */}
      <article className="console-panel" style={{ marginTop: '12px' }}>
        <span className="console-label">Release Wizard — publish a new version step by step</span>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'flex-end', marginTop: '10px' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: '1 1 320px' }}>
            <small>Local repo path (asked once, remembered on this browser)</small>
            <input
              onChange={(event) => setWizard((prev) => ({ ...prev, repoPath: event.target.value }))}
              placeholder={DEFAULT_REPO_PATH}
              type="text"
              value={wizard.repoPath}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <small>New version name (e.g. 1.3.0)</small>
            <input
              onChange={(event) => setWizard((prev) => ({ ...prev, versionName: event.target.value }))}
              placeholder="1.3.0"
              type="text"
              value={wizard.versionName}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <small>New version code (e.g. 5)</small>
            <input
              onChange={(event) => setWizard((prev) => ({ ...prev, versionCode: event.target.value }))}
              placeholder="5"
              type="text"
              value={wizard.versionCode}
            />
          </label>
        </div>
        {!setupDone ? (
          <p style={{ marginTop: '6px' }}>
            <small>Fill the repo path, a version name like 1.3.0 and an integer version code to unlock the steps.</small>
          </p>
        ) : (
          <p style={{ marginTop: '6px' }}>
            <small>
              Release in progress: <strong>{wizardReleaseId}</strong>
            </small>
          </p>
        )}

        <WizardStep index={1} title="Bump the version in build.gradle" done={wizard.bumpDone} locked={!setupDone}>
          <p>
            <small>
              Open <code>{repo}\frontend_hybrid\android\app\build.gradle</code> and set:
            </small>
          </p>
          <CommandBlock command={`versionCode ${wizard.versionCode.trim() || '<code>'}\nversionName "${wizard.versionName.trim() || '<name>'}"`} />
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '6px' }}>
            <input
              checked={wizard.bumpDone}
              onChange={(event) => setWizard((prev) => ({ ...prev, bumpDone: event.target.checked }))}
              type="checkbox"
            />
            <span>I updated and saved build.gradle</span>
          </label>
        </WizardStep>

        <WizardStep index={2} title="Build the app, deploy app hosting, build the signed APK" done={wizard.buildDone} locked={!setupDone || !wizard.bumpDone}>
          <p><small>Run in PowerShell (one block, in order):</small></p>
          <CommandBlock command={buildCommand} />
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '6px' }}>
            <input
              checked={wizard.buildDone}
              onChange={(event) => setWizard((prev) => ({ ...prev, buildDone: event.target.checked }))}
              type="checkbox"
            />
            <span>All commands finished without errors</span>
          </label>
        </WizardStep>

        <WizardStep
          index={3}
          title="Deploy the backend (ONLY if backend code changed in this release)"
          done={backendDone}
          locked={!setupDone || !wizard.bumpDone || !wizard.buildDone}
        >
          <CommandBlock command={backendCommand} />
          <div style={{ display: 'flex', gap: '12px', marginTop: '6px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <input
                checked={wizard.backendState === 'done'}
                onChange={() => setWizard((prev) => ({ ...prev, backendState: 'done' }))}
                type="radio"
              />
              <span>Backend deployed</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <input
                checked={wizard.backendState === 'skipped'}
                onChange={() => setWizard((prev) => ({ ...prev, backendState: 'skipped' }))}
                type="radio"
              />
              <span>Skip — no backend changes</span>
            </label>
          </div>
        </WizardStep>

        <WizardStep index={4} title="Upload the signed APK to the registry (GCS)" done={uploadDone} locked={!setupDone || !wizard.bumpDone || !wizard.buildDone || !backendDone}>
          <p>
            <small>
              Pick the file from: <code>{apkOutputPath}</code>
            </small>
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'flex-end', marginTop: '6px' }}>
            <input accept=".apk" ref={fileInputRef} type="file" />
            <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: '1 1 240px' }}>
              <small>Changelog (short, English)</small>
              <input onChange={(event) => setChangelog(event.target.value)} placeholder="What changed in this release" type="text" value={changelog} />
            </label>
            <button className="console-icon-text-button" disabled={uploading || uploadDone} onClick={handleWizardUpload} type="button">
              <UploadCloud aria-hidden="true" className={uploading ? 'spin' : undefined} size={17} />
              <span>{uploading ? 'Uploading…' : uploadDone ? 'Uploaded' : 'Upload to GCS'}</span>
            </button>
          </div>
        </WizardStep>

        <WizardStep index={5} title="Activate — publish on the website stable link" done={activateDone} locked={!uploadDone}>
          <p><small>One click. The site download button serves the new APK immediately; rollback = activate the previous row below.</small></p>
          <button
            className="console-icon-text-button"
            disabled={activatingId !== null || activateDone}
            onClick={() => handleActivate(wizardReleaseId)}
            type="button"
          >
            <Rocket aria-hidden="true" className={activatingId ? 'spin' : undefined} size={15} />
            <span>{activateDone ? 'Active' : activatingId ? 'Activating…' : `Activate ${wizardReleaseId}`}</span>
          </button>
        </WizardStep>

        <WizardStep index={6} title="Verify the live release" done={verifyDone} locked={!activateDone}>
          <button className="console-icon-text-button" disabled={verifying} onClick={handleVerify} type="button">
            <ShieldCheck aria-hidden="true" className={verifying ? 'spin' : undefined} size={15} />
            <span>{verifying ? 'Verifying…' : 'Run live verification'}</span>
          </button>
          {verifyResult ? (
            <ul style={{ marginTop: '8px', paddingInlineStart: '18px' }}>
              {verifyResult.checks.map((check) => (
                <li key={check.name} style={{ color: check.ok ? '#22c55e' : '#ef4444' }}>
                  {check.ok ? '✓' : '✗'} {check.name}: {check.detail}
                </li>
              ))}
            </ul>
          ) : null}
          {verifyDone ? (
            <p style={{ color: '#22c55e', marginTop: '6px' }}>
              Release {wizardReleaseId} is live. Update the release register doc (7007-0124) with this record.
            </p>
          ) : null}
        </WizardStep>
      </article>

      {/* ------------------------- Registry table ------------------------- */}
      <article className="firebase-release-history">
        <div className="firebase-release-history-head">
          <span className="console-label">Registered Releases</span>
          <small>{releases.length} rows</small>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9em' }}>
            <thead>
              <tr style={{ textAlign: 'left' }}>
                <th style={{ padding: '6px 8px' }}>Release</th>
                <th style={{ padding: '6px 8px' }}>Date</th>
                <th style={{ padding: '6px 8px' }}>Size</th>
                <th style={{ padding: '6px 8px' }}>Storage</th>
                <th style={{ padding: '6px 8px' }}>Changelog</th>
                <th style={{ padding: '6px 8px' }}>Uploaded</th>
                <th style={{ padding: '6px 8px' }}>Status</th>
                <th style={{ padding: '6px 8px' }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {releases.map((release: ApkRelease) => {
                const isActive = release.release_id === payload?.active_release_id;
                return (
                  <tr key={release.release_id} style={{ borderTop: '1px solid rgba(128,128,128,0.25)' }}>
                    <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>
                      <strong>{release.release_id}</strong>
                      <div><small style={{ wordBreak: 'break-all' }}>{release.file_name}</small></div>
                    </td>
                    <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>{release.released_at}</td>
                    <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>{formatBytes(release.size_bytes)}</td>
                    <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>{release.storage}</td>
                    <td style={{ padding: '6px 8px', minWidth: '180px' }}>{release.changelog}</td>
                    <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>
                      <small>{release.uploaded_by || '—'}</small>
                      <div><small>{formatDate(release.created_at)}</small></div>
                    </td>
                    <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>
                      {isActive ? (
                        <span style={{ color: '#22c55e', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                          <CheckCircle2 aria-hidden="true" size={15} /> active
                        </span>
                      ) : (
                        <span>archived</span>
                      )}
                    </td>
                    <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>
                      {isActive ? null : (
                        <button
                          className="console-icon-text-button"
                          disabled={activatingId !== null}
                          onClick={() => handleActivate(release.release_id)}
                          type="button"
                        >
                          <Rocket aria-hidden="true" className={activatingId === release.release_id ? 'spin' : undefined} size={15} />
                          <span>{activatingId === release.release_id ? 'Activating…' : 'Activate'}</span>
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {releases.length === 0 && !loading ? (
                <tr>
                  <td colSpan={8} style={{ padding: '12px 8px' }}>
                    No releases registered yet. Run the seed SQL first, then use the wizard above.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </article>
    </section>
  );
}
