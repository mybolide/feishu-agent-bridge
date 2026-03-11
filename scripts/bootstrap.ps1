param(
  [switch]$Dev = $true
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$packageFile = Join-Path $root "package.json"

if (!(Test-Path $packageFile)) {
  throw "package.json not found: $packageFile"
}

Push-Location $root
try {
  Write-Host "[setup] Installing root dependencies"
  npm install
  if ($LASTEXITCODE -ne 0) {
    throw "npm install failed (exit=$LASTEXITCODE)"
  }
} finally {
  Pop-Location
}

Write-Host "[setup] Done"
