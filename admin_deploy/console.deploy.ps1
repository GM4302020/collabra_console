# FILE: ~/otmega/otmega_app/console/admin_deploy/console.deploy.ps1
# ماموریت: اجرای deploy مستقیم Cloud Run برای سرویس otmega-console.

$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$FrontendPath = Join-Path $RepoRoot "console\admin_frontend"
$BackendPath = Join-Path $RepoRoot "console\admin_backend"
$StaticPath = Join-Path $BackendPath "static_frontend"
$SourceUiTextsPath = Join-Path $RepoRoot "backend\advisor\settings\ui_texts"
$PackagedAssetsPath = Join-Path $BackendPath "assets"
$PackagedUiTextsPath = Join-Path $PackagedAssetsPath "ui_texts"
$ProjectId = "ot-ai-advisor"
$ServiceName = "otmega-console"
$Region = "us-central1"
$RequiredSecrets = @(
    "FLASK_SECRET_KEY",
    "FALLBACK_ADMIN_USER",
    "FALLBACK_ADMIN_PASS",
    "PRG2_SUPABASE_URL",
    "PRG2_SUPABASE_SERVICE_ROLE_KEY",
    "GEMINI_API_KEY_25",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "gcs-signer-key"
)

function Invoke-CheckedStep {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Label,
        [Parameter(Mandatory = $true)]
        [scriptblock]$Command
    )

    Write-Host ""
    Write-Host "==> $Label"
    & $Command
}

Invoke-CheckedStep "Verify gcloud active account" {
    $ActiveAccount = gcloud auth list --filter=status:ACTIVE --format="value(account)"
    if (-not $ActiveAccount) {
        throw "No active gcloud account. Run gcloud auth login before deploying."
    }
    Write-Host "Active gcloud account: $ActiveAccount"
}

Invoke-CheckedStep "Verify required Secret Manager entries" {
    foreach ($SecretName in $RequiredSecrets) {
        gcloud secrets describe $SecretName --project $ProjectId --format="value(name)" | Out-Null
        Write-Host "Secret available: $SecretName"
    }
}

Invoke-CheckedStep "Install frontend dependencies" {
    Push-Location $FrontendPath
    try {
        npm ci
    } finally {
        Pop-Location
    }
}

Invoke-CheckedStep "Build frontend production bundle" {
    Push-Location $FrontendPath
    try {
        npm run build
    } finally {
        Pop-Location
    }
}

Invoke-CheckedStep "Run backend tests" {
    Push-Location $BackendPath
    try {
        python -m pytest tests
    } finally {
        Pop-Location
    }
}

Invoke-CheckedStep "Compile backend Python files" {
    Push-Location $BackendPath
    try {
        python -m compileall -q app.py admin_api tests
    } finally {
        Pop-Location
    }
}

Invoke-CheckedStep "Attach frontend bundle to Cloud Run source package" {
    $ResolvedBackend = Resolve-Path $BackendPath
    if (Test-Path $StaticPath) {
        $ResolvedStatic = Resolve-Path $StaticPath
        if (-not $ResolvedStatic.Path.StartsWith($ResolvedBackend.Path) -or (Split-Path $ResolvedStatic.Path -Leaf) -ne "static_frontend") {
            throw "Refusing to remove unexpected static path: $($ResolvedStatic.Path)"
        }
        Remove-Item -LiteralPath $ResolvedStatic.Path -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $StaticPath | Out-Null
    Copy-Item -Path (Join-Path $FrontendPath "dist\*") -Destination $StaticPath -Recurse -Force
    if (-not (Test-Path (Join-Path $StaticPath "index.html"))) {
        throw "Frontend index.html was not copied into static_frontend."
    }
}

Invoke-CheckedStep "Sync UI Texts .py files from database (source of truth)" {
    $SyncScript = Join-Path $PSScriptRoot "sync_ui_texts_from_db.py"
    if (-not (Test-Path $SyncScript)) {
        throw "UI Texts sync script not found: $SyncScript"
    }

    $SupabaseUrl = $null
    $SupabaseKey = $null
    $RawUrl = gcloud secrets versions access latest --secret="PRG2_SUPABASE_URL" --project $ProjectId 2>$null
    if ($LASTEXITCODE -eq 0 -and $RawUrl) { $SupabaseUrl = $RawUrl.Trim() }
    $RawKey = gcloud secrets versions access latest --secret="PRG2_SUPABASE_SERVICE_ROLE_KEY" --project $ProjectId 2>$null
    if ($LASTEXITCODE -eq 0 -and $RawKey) { $SupabaseKey = $RawKey.Trim() }

    if (-not $SupabaseUrl -or -not $SupabaseKey) {
        Write-Host "WARNING: Supabase secrets unavailable locally. Keeping existing .py files (no DB sync)."
    }

    try {
        if ($SupabaseUrl -and $SupabaseKey) {
            $env:PRG2_SUPABASE_URL = $SupabaseUrl
            $env:PRG2_SUPABASE_SERVICE_ROLE_KEY = $SupabaseKey
        }
        python $SyncScript --ui-texts-dir $SourceUiTextsPath
        if ($LASTEXITCODE -ne 0) {
            throw "UI Texts DB sync failed with exit code $LASTEXITCODE."
        }
    } finally {
        Remove-Item Env:\PRG2_SUPABASE_SERVICE_ROLE_KEY -ErrorAction SilentlyContinue
        Remove-Item Env:\PRG2_SUPABASE_URL -ErrorAction SilentlyContinue
    }
}

Invoke-CheckedStep "Attach UI Texts language files to Cloud Run source package" {
    $ResolvedBackend = Resolve-Path $BackendPath
    if (-not (Test-Path $SourceUiTextsPath)) {
        throw "Source UI Texts directory was not found: $SourceUiTextsPath"
    }
    if (Test-Path $PackagedUiTextsPath) {
        $ResolvedUiTexts = Resolve-Path $PackagedUiTextsPath
        if (-not $ResolvedUiTexts.Path.StartsWith($ResolvedBackend.Path) -or (Split-Path $ResolvedUiTexts.Path -Leaf) -ne "ui_texts") {
            throw "Refusing to remove unexpected UI Texts path: $($ResolvedUiTexts.Path)"
        }
        Remove-Item -LiteralPath $ResolvedUiTexts.Path -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $PackagedUiTextsPath | Out-Null
    Copy-Item -Path (Join-Path $SourceUiTextsPath "*.py") -Destination $PackagedUiTextsPath -Force
    if (-not (Test-Path (Join-Path $PackagedUiTextsPath "en.py"))) {
        throw "Packaged UI Texts en.py was not copied into admin_backend assets."
    }
}

Invoke-CheckedStep "Deploy production Admin Console to Cloud Run" {
    Push-Location $BackendPath
    try {
        gcloud run deploy $ServiceName `
  --source . `
  --region $Region `
  --project $ProjectId `
  --platform managed `
  --allow-unauthenticated `
  --set-env-vars="CONSOLE_MODE=read_only,CONSOLE_ADVISOR_ID=20018,APP_DATA_BUCKET_NAME=otmega-collabra-secure,GOOGLE_APPLICATION_CREDENTIALS=/secrets/gcs-signer-key,MAIN_BACKEND_URL=https://otmega-4utq3wq6ka-uc.a.run.app" `
  --set-secrets="FLASK_SECRET_KEY=FLASK_SECRET_KEY:latest" `
  --set-secrets="FALLBACK_ADMIN_USER=FALLBACK_ADMIN_USER:latest" `
  --set-secrets="FALLBACK_ADMIN_PASS=FALLBACK_ADMIN_PASS:latest" `
  --set-secrets="PRG2_SUPABASE_URL=PRG2_SUPABASE_URL:latest" `
  --set-secrets="PRG2_SUPABASE_SERVICE_ROLE_KEY=PRG2_SUPABASE_SERVICE_ROLE_KEY:latest" `
  --set-secrets="GEMINI_API_KEY_25=GEMINI_API_KEY_25:latest" `
  --set-secrets="OPENAI_API_KEY=OPENAI_API_KEY:latest" `
  --set-secrets="OPENROUTER_API_KEY=OPENROUTER_API_KEY:latest" `
  --set-secrets="/secrets/gcs-signer-key=gcs-signer-key:latest"
    } finally {
        Pop-Location
    }
}
