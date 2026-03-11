param()

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$bootstrap = Join-Path $PSScriptRoot "bootstrap.ps1"

& $bootstrap -Dev

Push-Location $root
try {
  & (Join-Path $PSScriptRoot "lint.ps1") -SkipInstall
} finally {
  Pop-Location
}

Write-Host "[build] Node lint validation complete"
