$ErrorActionPreference = "SilentlyContinue"

$projectRoot = [string](Resolve-Path (Join-Path $PSScriptRoot ".."))
$logDir = Join-Path $projectRoot "logs"
$pidFile = Join-Path $logDir "gateway-processes.json"

function Normalize-Text {
  param([string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) {
    return ""
  }
  return $Value.ToLower().Replace("\", "/")
}

function Test-RelativeGatewayCommand {
  param(
    [string]$CommandLine,
    [string]$ProcessName
  )
  $cmdNorm = Normalize-Text $CommandLine
  $nameNorm = Normalize-Text $ProcessName
  if (-not $cmdNorm) {
    return $false
  }
  $isGatewayRelative = $cmdNorm.Contains("--watch gateway/main.js") `
    -or $cmdNorm.Contains("/c node --watch gateway/main.js") `
    -or $cmdNorm.Contains(" gateway/main.js") `
    -or $cmdNorm.EndsWith("gateway/main.js")
  if (-not $isGatewayRelative) {
    return $false
  }
  return $nameNorm -eq "node.exe" -or $nameNorm -eq "cmd.exe"
}

function Get-ProcessMap {
  $map = @{}
  foreach ($proc in Get-CimInstance Win32_Process) {
    $procId = [int]$proc.ProcessId
    $map[$procId] = [pscustomobject]@{
      Pid = $procId
      ParentPid = [int]($proc.ParentProcessId)
      Name = [string]$proc.Name
      CommandLine = [string]$proc.CommandLine
    }
  }
  return $map
}

function Get-ProcessTreePids {
  param(
    [int]$RootPid,
    $Map
  )
  if (-not $Map.ContainsKey($RootPid)) {
    return @()
  }
  $visited = New-Object "System.Collections.Generic.HashSet[int]"
  $queue = New-Object "System.Collections.Generic.Queue[int]"
  $queue.Enqueue($RootPid)
  while ($queue.Count -gt 0) {
    $currentPid = $queue.Dequeue()
    if (-not $visited.Add($currentPid)) {
      continue
    }
    foreach ($entry in $Map.Values) {
      if ($entry.ParentPid -eq $currentPid) {
        $queue.Enqueue([int]$entry.Pid)
      }
    }
  }
  return @($visited)
}

function Stop-PidList {
  param(
    [int[]]$Pids,
    [string]$Reason
  )
  $killed = 0
  foreach ($targetPid in ($Pids | Sort-Object -Descending -Unique)) {
    if ($targetPid -le 0 -or $targetPid -eq $PID) {
      continue
    }
    try {
      Stop-Process -Id $targetPid -Force -ErrorAction Stop
      $killed += 1
    } catch {
      # process may have already exited
    }
  }
  if ($killed -gt 0) {
    Write-Host "[kill] stopped $killed process(es) by $Reason"
  }
  return $killed
}

$totalKilled = 0
$processMap = Get-ProcessMap

$pidFileRootPids = @()
if (Test-Path $pidFile) {
  try {
    $raw = Get-Content -Path $pidFile -Raw
    $parsed = $raw | ConvertFrom-Json
    if ($parsed -and $parsed.gatewayPid) {
      $pidFileRootPids += [int]$parsed.gatewayPid
    }
    if ($parsed -and $parsed.opencodePid) {
      $pidFileRootPids += [int]$parsed.opencodePid
    }
    if ($parsed -and $parsed.extraPids) {
      foreach ($extraPid in @($parsed.extraPids)) {
        if ($extraPid) {
          $pidFileRootPids += [int]$extraPid
        }
      }
    }
  } catch {
    Write-Warning "[kill] failed to parse pid file: $($_.Exception.Message)"
  }
}

if ($pidFileRootPids.Count -gt 0) {
  $treePids = @()
  foreach ($rootPid in ($pidFileRootPids | Sort-Object -Unique)) {
    $treePids += Get-ProcessTreePids -RootPid $rootPid -Map $processMap
  }
  $totalKilled += Stop-PidList -Pids $treePids -Reason "pid-file"
}

$projectNorm = Normalize-Text $projectRoot
$fallbackRoots = @()
foreach ($entry in $processMap.Values) {
  $cmdNorm = Normalize-Text $entry.CommandLine
  if (-not $cmdNorm) {
    continue
  }
  $containsRoot = $cmdNorm.Contains($projectNorm)
  $isRelativeGatewayCmd = Test-RelativeGatewayCommand -CommandLine $entry.CommandLine -ProcessName $entry.Name
  if (-not $containsRoot -and -not $isRelativeGatewayCmd) {
    continue
  }
  $isGatewayLike = $cmdNorm.Contains("gateway/main.js") `
    -or $cmdNorm.Contains("node-gateway.out.log") `
    -or $cmdNorm.Contains("node-gateway.err.log")
  $isOpenCodeServeLike = $cmdNorm.Contains("opencode-serve.out.log") `
    -or $cmdNorm.Contains("opencode-serve.err.log")
  $isProjectNpmDev = $cmdNorm.Contains("npm-cli.js") `
    -and $cmdNorm.Contains("--prefix") `
    -and $cmdNorm.Contains(" run dev")

  if ($isGatewayLike -or $isOpenCodeServeLike -or $isProjectNpmDev) {
    $fallbackRoots += [int]$entry.Pid
  }
}

if ($fallbackRoots.Count -gt 0) {
  $refreshedMap = Get-ProcessMap
  $fallbackTree = @()
  foreach ($rootPid in ($fallbackRoots | Sort-Object -Unique)) {
    $fallbackTree += Get-ProcessTreePids -RootPid $rootPid -Map $refreshedMap
  }
  $totalKilled += Stop-PidList -Pids $fallbackTree -Reason "project-marker"
}

if (Test-Path $pidFile) {
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}

Start-Sleep -Milliseconds 800
Write-Host "[kill] gateway-related processes stopped: $totalKilled (project-only)"
