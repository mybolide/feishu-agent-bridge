param(
  [int]$Port = 7071,
  [switch]$SkipInstall,
  [switch]$SkipOpenCodeServer
)

$ErrorActionPreference = "Stop"
$startScript = Join-Path $PSScriptRoot "start.ps1"

if (!(Test-Path $startScript)) {
  throw "Missing start script: $startScript"
}

$splat = @{ Port = $Port }
if ($SkipInstall) {
  $splat.SkipInstall = $true
}
if ($SkipOpenCodeServer) {
  $splat.SkipOpenCodeServer = $true
}

& $startScript @splat
