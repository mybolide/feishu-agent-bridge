$ErrorActionPreference = "SilentlyContinue"

$projectRoot = [string](Resolve-Path (Join-Path $PSScriptRoot ".."))
$logDir = Join-Path $projectRoot "logs"
$pidFile = Join-Path $logDir "gateway-processes.json"

function Get-EnvValue {
  param([string]$Key, [string]$Default = "")
  $existing = [Environment]::GetEnvironmentVariable($Key)
  if ($existing -and $existing.Trim() -ne "") {
    return $existing.Trim()
  }
  $envFile = Join-Path $projectRoot ".env"
  if (Test-Path $envFile) {
    $line = Get-Content $envFile | Where-Object { $_ -match "^\s*$Key\s*=" } | Select-Object -First 1
    if ($line) {
      return ($line -split "=", 2)[1].Trim()
    }
  }
  return $Default
}

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

function Test-IsOpenCodeServeCommand {
  param(
    [string]$CommandLine,
    [string]$ProcessName
  )
  $cmdNorm = Normalize-Text $CommandLine
  $nameNorm = Normalize-Text $ProcessName
  if (-not $cmdNorm) {
    return $false
  }
  if ($nameNorm -eq "opencode.exe") {
    return $cmdNorm.Contains(" serve")
  }
  return $cmdNorm.Contains("opencode") -and $cmdNorm.Contains(" serve")
}

function Test-IsLoopbackOpenCodeServeCommand {
  param(
    [string]$CommandLine,
    [string]$ProcessName
  )
  if (-not (Test-IsOpenCodeServeCommand -CommandLine $CommandLine -ProcessName $ProcessName)) {
    return $false
  }
  $cmdNorm = Normalize-Text $CommandLine
  return $cmdNorm.Contains("--hostname 127.0.0.1") `
    -or $cmdNorm.Contains("--hostname localhost") `
    -or $cmdNorm.Contains("--hostname ::1")
}

function Resolve-OpenCodeServePort {
  param([string]$CommandLine)
  $raw = [string]$CommandLine
  if (-not $raw) {
    return 0
  }
  $match = [regex]::Match($raw, '--port(?:\s+|=)(\d+)', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
  if (-not $match.Success) {
    return 0
  }
  try {
    return [int]$match.Groups[1].Value
  } catch {
    return 0
  }
}

function Get-OpenCodeCandidatePorts {
  param(
    [string]$ServerUrl,
    [int]$ScanLimit = 40
  )
  $normalized = [string]$ServerUrl
  if (-not $normalized) {
    $normalized = "http://127.0.0.1:24096"
  }
  try {
    $uri = [System.Uri]$normalized
  } catch {
    $uri = [System.Uri]"http://127.0.0.1:24096"
  }
  $hostName = if ($uri.Host) { $uri.Host } else { "127.0.0.1" }
  if (@("127.0.0.1", "localhost", "::1") -notcontains $hostName.ToLower()) {
    return @()
  }
  $startPort = if ($uri.Port -gt 0) { $uri.Port } else { 24096 }
  $ports = @()
  $basePorts = @($startPort, 24096, 14096) | Select-Object -Unique
  $maxOffset = [Math]::Max(0, $ScanLimit)
  foreach ($basePort in $basePorts) {
    for ($offset = 0; $offset -le $maxOffset; $offset++) {
      $ports += ($basePort + $offset)
    }
  }
  return @($ports | Sort-Object -Unique)
}

function Resolve-OpenCodeRootPid {
  param(
    [int]$TargetPid,
    $Map
  )
  if (-not $Map.ContainsKey($TargetPid)) {
    return 0
  }
  $currentPid = [int]$TargetPid
  $rootPid = $currentPid
  while ($Map.ContainsKey($currentPid)) {
    $row = $Map[$currentPid]
    if (-not (Test-IsOpenCodeServeCommand -CommandLine $row.CommandLine -ProcessName $row.Name)) {
      break
    }
    $rootPid = [int]$currentPid
    $parentPid = [int]$row.ParentPid
    if ($parentPid -le 0 -or $parentPid -eq $currentPid -or -not $Map.ContainsKey($parentPid)) {
      break
    }
    $currentPid = $parentPid
  }
  return $rootPid
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

$candidatePorts = @()
try {
  $scanLimit = [Math]::Max(0, [int](Get-EnvValue -Key "OPENCODE_DISCOVERY_SCAN_LIMIT" -Default "40"))
} catch {
  $scanLimit = 40
}
$candidatePorts = Get-OpenCodeCandidatePorts -ServerUrl (Get-EnvValue -Key "OPENCODE_SERVER_URL" -Default "http://127.0.0.1:24096") -ScanLimit $scanLimit
if ($candidatePorts.Count -gt 0) {
  $opencodeRoots = @()
  $loopbackMap = Get-ProcessMap
  foreach ($entry in $loopbackMap.Values) {
    if (-not (Test-IsLoopbackOpenCodeServeCommand -CommandLine $entry.CommandLine -ProcessName $entry.Name)) {
      continue
    }
    $servePort = Resolve-OpenCodeServePort -CommandLine $entry.CommandLine
    if ($servePort -le 0 -or ($candidatePorts -notcontains $servePort)) {
      continue
    }
    $rootPid = Resolve-OpenCodeRootPid -TargetPid ([int]$entry.Pid) -Map $loopbackMap
    if ($rootPid -gt 0) {
      $opencodeRoots += $rootPid
    }
  }
  if ($opencodeRoots.Count -gt 0) {
    $refreshedMap = Get-ProcessMap
    $opencodeTree = @()
    foreach ($rootPid in ($opencodeRoots | Sort-Object -Unique)) {
      $opencodeTree += Get-ProcessTreePids -RootPid $rootPid -Map $refreshedMap
    }
    $totalKilled += Stop-PidList -Pids $opencodeTree -Reason "loopback-opencode"
  }
}

if (Test-Path $pidFile) {
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}

Start-Sleep -Milliseconds 800
Write-Host "[kill] gateway-related processes stopped: $totalKilled (project-only)"
