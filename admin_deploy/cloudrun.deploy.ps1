# FILE: ~/otmega/otmega_app/console/admin_deploy/cloudrun.deploy.ps1
# ماموریت: اجرای deploy مستقیم Cloud Run برای سرویس otmega-console.

$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$FrontendPath = Join-Path $RepoRoot "console\admin_frontend"
$BackendPath = Join-Path $RepoRoot "console\admin_backend"
$StaticPath = Join-Path $BackendPath "static_frontend"

Push-Location $FrontendPath
npm install
npm run build
Pop-Location

if (Test-Path $StaticPath) {
    Remove-Item -LiteralPath $StaticPath -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $StaticPath | Out-Null
Copy-Item -Path (Join-Path $FrontendPath "dist\*") -Destination $StaticPath -Recurse -Force

Push-Location $BackendPath
gcloud run deploy otmega-console `
  --source . `
  --region us-central1 `
  --project ot-ai-advisor `
  --platform managed `
  --allow-unauthenticated `
  --set-env-vars="CONSOLE_MODE=read_only,CONSOLE_ADVISOR_ID=20018,APP_DATA_BUCKET_NAME=otmega-collabra-secure,GOOGLE_APPLICATION_CREDENTIALS=/secrets/gcs-signer-key" `
  --set-secrets="FLASK_SECRET_KEY=FLASK_SECRET_KEY:latest" `
  --set-secrets="FALLBACK_ADMIN_USER=FALLBACK_ADMIN_USER:latest" `
  --set-secrets="FALLBACK_ADMIN_PASS=FALLBACK_ADMIN_PASS:latest" `
  --set-secrets="PRG2_SUPABASE_URL=PRG2_SUPABASE_URL:latest" `
  --set-secrets="PRG2_SUPABASE_SERVICE_ROLE_KEY=PRG2_SUPABASE_SERVICE_ROLE_KEY:latest" `
  --set-secrets="/secrets/gcs-signer-key=gcs-signer-key:latest"
Pop-Location
