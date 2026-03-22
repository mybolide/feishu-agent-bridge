# Simple gateway process killer - only kills gateway, NOT opencode serve
$ErrorActionPreference = "SilentlyContinue"

$projectRoot = [string](Resolve-Path (Join-Path $PSScriptRoot ".."))
$logDir = Join-Path $projectRoot "logs"
$pidFilePath = Join-Path $logDir "gateway-processes.json"
$myPid = $PID

Write-Host "[kill] stopping gateway processes..."

$killed = 0

# Get node processes - only kill gateway/main.js
$output = cmd /c 'wmic process where "name=''node.exe''" get ProcessId,CommandLine 2>nul'

foreach ($line in $output) {
  if ($line -match "gateway/main.js") {
    $trimmed = $line.TrimEnd()
    $lastSpace = $trimmed.LastIndexOf(" ")
    if ($lastSpace -gt 0) {
      $targetPidStr = $trimmed.Substring($lastSpace).Trim()
      $targetPid = 0
      if ([int]::TryParse($targetPidStr, [ref]$targetPid)) {
        if ($targetPid -gt 0 -and $targetPid -ne $myPid) {
          taskkill /F /PID $targetPid | Out-Null
          Write-Host "[kill] killed gateway process: $targetPid"
          $killed += 1
        }
      }
    }
  }
}

# Clean up PID file
if (Test-Path $pidFilePath) {
  Remove-Item $pidFilePath -Force -ErrorAction SilentlyContinue
}

Write-Host "[kill] stopped $killed process(es)"
