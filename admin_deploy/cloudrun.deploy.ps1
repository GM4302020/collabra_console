# FILE: ~/otmega/otmega_app/console/admin_deploy/cloudrun.deploy.ps1
# ماموریت: حفظ دستور قدیمی deploy و هدایت آن به اسکریپت رسمی console.deploy.ps1.

$ErrorActionPreference = "Stop"

$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$DeployScript = Join-Path $ScriptRoot "console.deploy.ps1"

& $DeployScript @args

if ($LASTEXITCODE -ne 0) {
    throw "console.deploy.ps1 failed with exit code $LASTEXITCODE"
}
