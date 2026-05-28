# FILE: ~/otmega/otmega_app/console/admin_deploy/firebase-hosting.deploy.ps1
# ماموریت: اجرای build و deploy فرانت جدا روی Firebase Hosting در صورت جداسازی.

$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$FrontendPath = Join-Path $RepoRoot "console\admin_frontend"

Push-Location $FrontendPath
npm install
npm run build
firebase deploy --only hosting --project ot-ai-advisor
Pop-Location
