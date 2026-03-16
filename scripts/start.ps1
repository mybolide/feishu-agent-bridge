param(
  [int]$Port = 7071,
  [switch]$SkipInstall,
  [switch]$SkipOpenCodeServer,
  [switch]$DisableAutoRestart
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$nodePackage = Join-Path $root "package.json"
$gatewayEntry = Join-Path $root "gateway\main.js"
$logDir = Join-Path $root "logs"
$pidFile = Join-Path $logDir "gateway-processes.json"

if (!(Test-Path $nodePackage)) {
  throw "package.json not found: $nodePackage"
}
if (!(Test-Path $gatewayEntry)) {
  throw "gateway entry not found: $gatewayEntry"
}
if (!(Test-Path $logDir)) {
  New-Item -ItemType Directory -Path $logDir | Out-Null
}

function Get-EnvValue {
  param([string]$Key, [string]$Default = "")
  $existing = [Environment]::GetEnvironmentVariable($Key)
  if ($existing -and $existing.Trim() -ne "") {
    return $existing.Trim()
  }
  $envFile = Join-Path $root ".env"
  if (Test-Path $envFile) {
    $line = Get-Content $envFile | Where-Object { $_ -match "^\s*$Key\s*=" } | Select-Object -First 1
    if ($line) {
      return ($line -split "=", 2)[1].Trim()
    }
  }
  return $Default
}

function Test-TcpPort {
  param([string]$HostName, [int]$TargetPort, [int]$TimeoutMs = 1000)
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $iar = $client.BeginConnect($HostName, $TargetPort, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne($TimeoutMs, $false)) {
      $client.Close()
      return $false
    }
    $client.EndConnect($iar)
    $client.Close()
    return $true
  } catch {
    return $false
  }
}

function Test-OpenCodeHealth {
  param([string]$ServerUrl, [int]$TimeoutMs = 2500)
  $client = $null
  $handler = $null
  try {
    $baseUrl = [string]$ServerUrl
    if (-not $baseUrl) {
      return $false
    }
    $healthUrl = $baseUrl.TrimEnd("/") + "/global/health"
    $handler = New-Object System.Net.Http.HttpClientHandler
    $handler.UseProxy = $false
    $client = New-Object System.Net.Http.HttpClient($handler)
    $client.Timeout = [TimeSpan]::FromMilliseconds([Math]::Max(500, $TimeoutMs))
    $response = $client.GetAsync($healthUrl).GetAwaiter().GetResult()
    if (-not $response.IsSuccessStatusCode) {
      return $false
    }
    $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    if (-not $body) {
      return $false
    }
    $json = $body | ConvertFrom-Json -ErrorAction Stop
    return ($json.healthy -eq $true) -and (-not [string]::IsNullOrWhiteSpace([string]$json.version))
  } catch {
    return $false
  } finally {
    if ($client) {
      $client.Dispose()
    }
    if ($handler) {
      $handler.Dispose()
    }
  }
}

function Find-FreeTcpPort {
  param(
    [string]$HostName,
    [int]$StartPort,
    [int]$MaxAttempts = 30
  )
  $begin = [Math]::Max(1024, $StartPort)
  for ($port = $begin; $port -lt ($begin + [Math]::Max(1, $MaxAttempts)); $port++) {
    if (-not (Test-TcpPort -HostName $HostName -TargetPort $port)) {
      return $port
    }
  }
  return 0
}

function Get-OpenCodeCandidateUrls {
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

  $scheme = if ($uri.Scheme) { $uri.Scheme } else { "http" }
  $hostName = if ($uri.Host) { $uri.Host } else { "127.0.0.1" }
  $port = if ($uri.Port -gt 0) { $uri.Port } else { 24096 }
  $base = "${scheme}://${hostName}:$port"
  $results = [System.Collections.Generic.List[string]]::new()
  $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)

  $push = {
    param([string]$Value)
    $candidate = [string]$Value
    if (-not $candidate) {
      return
    }
    if ($candidate.EndsWith("/")) {
      $candidate = $candidate.TrimEnd("/")
    }
    if ($seen.Add($candidate)) {
      $results.Add($candidate)
    }
  }

  & $push $base

  $loopbackHosts = @("127.0.0.1", "localhost", "::1")
  if ($loopbackHosts -notcontains $hostName.ToLower()) {
    return @($results)
  }

  $legacyBasePorts = @($port, 24096, 14096) | Select-Object -Unique
  $maxOffset = [Math]::Max(0, $ScanLimit)
  foreach ($basePort in $legacyBasePorts) {
    for ($offset = 0; $offset -le $maxOffset; $offset++) {
      & $push "${scheme}://${hostName}:$($basePort + $offset)"
    }
  }

  return @($results)
}

function Test-LoopbackHost {
  param([string]$HostName)
  $normalized = [string]$HostName
  if (-not $normalized) {
    return $false
  }
  return @("127.0.0.1", "localhost", "::1") -contains $normalized.ToLower()
}

function Get-PortOwnerProcessIds {
  param([int]$TargetPort)
  try {
    return @(
      Get-NetTCPConnection -LocalPort $TargetPort -ErrorAction Stop |
        Select-Object -ExpandProperty OwningProcess -Unique |
        Where-Object { $_ -and $_ -gt 0 }
    )
  } catch {
    return @()
  }
}

function Get-ProcessRowById {
  param([int]$ProcessId)
  try {
    return Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop | Select-Object -First 1
  } catch {
    return $null
  }
}

function Get-ProcessChain {
  param(
    [int]$ProcessId,
    [int]$MaxDepth = 10
  )
  $rows = [System.Collections.Generic.List[object]]::new()
  $seen = [System.Collections.Generic.HashSet[int]]::new()
  $currentId = [int]$ProcessId

  for ($depth = 0; $depth -lt [Math]::Max(1, $MaxDepth); $depth++) {
    if ($currentId -le 0) {
      break
    }
    if (-not $seen.Add($currentId)) {
      break
    }
    $row = Get-ProcessRowById -ProcessId $currentId
    if (-not $row) {
      break
    }
    $rows.Add($row)
    $parentId = [int]$row.ParentProcessId
    if ($parentId -le 0 -or $parentId -eq $currentId) {
      break
    }
    $currentId = $parentId
  }

  return @($rows)
}

function Test-IsOpenCodeProcessRow {
  param($Row)
  if (-not $Row) {
    return $false
  }
  $name = [string]$Row.Name
  $commandLine = [string]$Row.CommandLine
  $nameNorm = $name.ToLower()
  $cmdNorm = $commandLine.ToLower()
  if ($nameNorm -eq "opencode.exe") {
    return $true
  }
  return $cmdNorm.Contains("opencode") -and $cmdNorm.Contains(" serve")
}

function Resolve-HealthyOpenCodeServerUrl {
  param(
    [string]$ServerUrl,
    [int]$ScanLimit = 40,
    [int]$TimeoutMs = 2500
  )
  $candidates = Get-OpenCodeCandidateUrls -ServerUrl $ServerUrl -ScanLimit $ScanLimit
  foreach ($candidate in $candidates) {
    if (Test-OpenCodeHealth -ServerUrl $candidate -TimeoutMs $TimeoutMs) {
      return $candidate
    }
  }
  return ""
}

function Stop-OpenCodeProcessesOnPort {
  param([int]$TargetPort, [string]$Reason = "restart")
  $ownerPids = Get-PortOwnerProcessIds -TargetPort $TargetPort
  if ($ownerPids.Count -eq 0) {
    return $false
  }

  $rootPids = [System.Collections.Generic.HashSet[int]]::new()
  foreach ($ownerPid in $ownerPids) {
    $chain = Get-ProcessChain -ProcessId $ownerPid
    $matchingRows = @($chain | Where-Object { Test-IsOpenCodeProcessRow -Row $_ })
    if ($matchingRows.Count -gt 0) {
      $rootPid = [int]$matchingRows[-1].ProcessId
      if ($rootPid -gt 0 -and $rootPid -ne $PID) {
        [void]$rootPids.Add($rootPid)
      }
    }
  }

  if ($rootPids.Count -eq 0) {
    return $false
  }

  foreach ($rootPid in @($rootPids | Sort-Object -Descending)) {
    try {
      & cmd.exe /c "taskkill /PID $rootPid /T /F" | Out-Null
      Write-Host "[start] killed OpenCode process tree $rootPid on port $TargetPort ($Reason)"
    } catch {
      Write-Warning "[start] failed to kill OpenCode tree pid=$rootPid on port ${TargetPort}: $($_.Exception.Message)"
    }
  }

  Start-Sleep -Milliseconds 800
  return $true
}

function Resolve-OpenCodeRestartServerUrl {
  param(
    [string]$ServerUrl,
    [int]$ScanLimit = 40
  )
  $candidates = Get-OpenCodeCandidateUrls -ServerUrl $ServerUrl -ScanLimit $ScanLimit
  foreach ($candidate in $candidates) {
    try {
      $uri = [System.Uri]$candidate
    } catch {
      continue
    }
    $hostName = if ($uri.Host) { $uri.Host } else { "127.0.0.1" }
    $targetPort = if ($uri.Port -gt 0) { $uri.Port } else { 24096 }
    if (-not (Test-LoopbackHost -HostName $hostName)) {
      continue
    }

    if (-not (Test-TcpPort -HostName $hostName -TargetPort $targetPort)) {
      return $candidate
    }

    if (Stop-OpenCodeProcessesOnPort -TargetPort $targetPort -Reason "restarting stale OpenCode server") {
      if (-not (Test-TcpPort -HostName $hostName -TargetPort $targetPort)) {
        Write-Host "[start] reclaimed OpenCode port $targetPort for a fresh server start"
        return $candidate
      }
    }

    Write-Warning "[start] OpenCode candidate $candidate is occupied by a non-OpenCode process; trying next port"
  }

  return ""
}

function Stop-ProcessesOnPort {
  param([int]$TargetPort, [string]$Reason = "restart")
  $rows = Get-PortOwnerProcessIds -TargetPort $TargetPort
  foreach ($procId in @($rows)) {
    if ($procId -and $procId -ne $PID) {
      try {
        Stop-Process -Id $procId -Force -ErrorAction Stop
        Write-Host "[start] killed process $procId on port $TargetPort ($Reason)"
      } catch {
        Write-Warning "[start] failed to kill pid=$procId on port ${TargetPort}: $($_.Exception.Message)"
      }
    }
  }
}

function Wait-Port {
  param([string]$HostName, [int]$TargetPort, [int]$Rounds = 20)
  for ($i = 0; $i -lt $Rounds; $i++) {
    if (Test-TcpPort -HostName $HostName -TargetPort $TargetPort) {
      return $true
    }
    Start-Sleep -Seconds 1
  }
  return $false
}

function Wait-LogPattern {
  param(
    [string]$FilePath,
    [string[]]$Patterns,
    [int]$Rounds = 30
  )
  for ($i = 0; $i -lt $Rounds; $i++) {
    if (Test-Path $FilePath) {
      $text = Get-Content -Path $FilePath -Raw -ErrorAction SilentlyContinue
      foreach ($pattern in $Patterns) {
        if ($text -like "*$pattern*") {
          return $true
        }
      }
    }
    Start-Sleep -Seconds 1
  }
  return $false
}

function Wait-LogPatternAll {
  param(
    [string]$FilePath,
    [string[]]$Patterns,
    [int]$Rounds = 30
  )
  for ($i = 0; $i -lt $Rounds; $i++) {
    if (Test-Path $FilePath) {
      $text = Get-Content -Path $FilePath -Raw -ErrorAction SilentlyContinue
      $allMatched = $true
      foreach ($pattern in $Patterns) {
        if ($text -notlike "*$pattern*") {
          $allMatched = $false
          break
        }
      }
      if ($allMatched) {
        return $true
      }
    }
    Start-Sleep -Seconds 1
  }
  return $false
}

function Write-GatewayPidFile {
  param(
    [string]$FilePath,
    [string]$ProjectRoot,
    [int]$GatewayPid,
    [int]$OpenCodePid = 0,
    [int[]]$ExtraPids = @()
  )
  $normalizedExtraPids = @($ExtraPids | Where-Object { $_ -gt 0 } | Sort-Object -Unique)
  $payload = [ordered]@{
    projectRoot = [string]$ProjectRoot
    updatedAt = [DateTimeOffset]::UtcNow.ToString("o")
    gatewayPid = [int]$GatewayPid
    opencodePid = if ($OpenCodePid -gt 0) { [int]$OpenCodePid } else { 0 }
    extraPids = $normalizedExtraPids
  }
  $json = $payload | ConvertTo-Json -Depth 4
  Set-Content -Path $FilePath -Value $json -Encoding UTF8
}

function Find-GatewayRuntimePids {
  param([string]$ProjectRoot)
  $projectNorm = ([string]$ProjectRoot).ToLower().Replace("\", "/")
  $gatewayNorm = ((Join-Path $ProjectRoot "gateway\main.js")).ToLower().Replace("\", "/")
  $pids = @()
  try {
    $rows = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'"
  } catch {
    $rows = @()
  }
  foreach ($row in $rows) {
    $cmd = [string]$row.CommandLine
    if ([string]::IsNullOrWhiteSpace($cmd)) {
      continue
    }
    $cmdNorm = $cmd.ToLower().Replace("\", "/")
    if ($cmdNorm.Contains($projectNorm) -and $cmdNorm.Contains("gateway/main.js")) {
      $pids += [int]$row.ProcessId
      continue
    }
    if ($cmdNorm.Contains($gatewayNorm)) {
      $pids += [int]$row.ProcessId
    }
  }
  return @($pids | Sort-Object -Unique)
}

function Start-OpenCodeServeProcess {
  param(
    [string]$CommandPath,
    [string]$HostName,
    [int]$TargetPort,
    [string]$WorkDir,
    [string]$OutLog,
    [string]$ErrLog
  )
  $cmd = [string]$CommandPath
  if (-not $cmd) {
    return $null
  }
  try {
    if ($cmd.ToLower().EndsWith(".cmd") -or $cmd.ToLower().EndsWith(".bat")) {
      $line = "`"$cmd`" serve --hostname $HostName --port $TargetPort"
      return Start-Process -WindowStyle Hidden -FilePath "cmd.exe" -ArgumentList @("/c", $line) -WorkingDirectory $WorkDir -RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog -PassThru
    } elseif ($cmd.ToLower().EndsWith(".ps1")) {
      return Start-Process -WindowStyle Hidden -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $cmd, "serve", "--hostname", $HostName, "--port", "$TargetPort") -WorkingDirectory $WorkDir -RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog -PassThru
    } else {
      return Start-Process -WindowStyle Hidden -FilePath $cmd -ArgumentList @("serve", "--hostname", $HostName, "--port", "$TargetPort") -WorkingDirectory $WorkDir -RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog -PassThru
    }
  } catch {
    return $null
  }
}

function Stop-GatewayWatchers {
  $killScript = Join-Path $PSScriptRoot "kill_gateway_processes.ps1"
  if (Test-Path $killScript) {
    try {
      & $killScript
    } catch {
      Write-Warning "[start] kill script failed: $($_.Exception.Message)"
    }
  }
}

Stop-GatewayWatchers
Stop-ProcessesOnPort -TargetPort $Port -Reason "node-gateway restart"
if (Test-Path $pidFile) {
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}
$openCodeProc = $null

if (-not $SkipInstall) {
  Write-Host "[start] syncing node dependencies..."
  Push-Location $root
  try {
    npm install
  } finally {
    Pop-Location
  }
}

if (-not $SkipOpenCodeServer) {
  $serverUrl = Get-EnvValue -Key "OPENCODE_SERVER_URL" -Default "http://127.0.0.1:24096"
  $scanLimit = 40
  try {
    $scanLimit = [Math]::Max(0, [int](Get-EnvValue -Key "OPENCODE_DISCOVERY_SCAN_LIMIT" -Default "40"))
  } catch {
    $scanLimit = 40
  }
  $isLoopbackServer = $false
  try {
    $serverUri = [System.Uri]$serverUrl
    $isLoopbackServer = Test-LoopbackHost -HostName $serverUri.Host
  } catch {
    $isLoopbackServer = $true
  }
  $restartServerUrl = ""
  if ($isLoopbackServer) {
    $restartServerUrl = Resolve-OpenCodeRestartServerUrl -ServerUrl $serverUrl -ScanLimit $scanLimit
    if ($restartServerUrl) {
      $serverUrl = $restartServerUrl
    }
  }
  $existingHealthyServerUrl = ""
  if (-not $restartServerUrl) {
    $existingHealthyServerUrl = Resolve-HealthyOpenCodeServerUrl -ServerUrl $serverUrl -ScanLimit $scanLimit -TimeoutMs 2500
  }
  if ($existingHealthyServerUrl) {
    $env:OPENCODE_SERVER_URL = $existingHealthyServerUrl
    Write-Host "[start] OpenCode server already healthy at $existingHealthyServerUrl"
  } else {
  try {
    $uri = [System.Uri]$serverUrl
    $scheme = if ($uri.Scheme) { $uri.Scheme } else { "http" }
    $hostName = if ($uri.Host) { $uri.Host } else { "127.0.0.1" }
    $ocPort = if ($uri.Port -gt 0) { $uri.Port } else { 24096 }
  } catch {
    $scheme = "http"
    $hostName = "127.0.0.1"
    $ocPort = 24096
  }
  $serverUrl = "${scheme}://${hostName}:$ocPort"
  $portReachable = Test-TcpPort -HostName $hostName -TargetPort $ocPort

  if ($portReachable) {
    Write-Warning "[start] OpenCode health check failed at $serverUrl; port $ocPort is occupied by a non-OpenCode or unhealthy process"
    $fallbackPort = Find-FreeTcpPort -HostName $hostName -StartPort ($ocPort + 1) -MaxAttempts 40
    if ($fallbackPort -le 0) {
      Write-Warning "[start] no free fallback port found near $ocPort, will retry the configured port"
    } else {
      $ocPort = $fallbackPort
      $serverUrl = "${scheme}://${hostName}:$ocPort"
      Write-Host "[start] switching OpenCode server to fallback port $ocPort"
    }
  }
  $env:OPENCODE_SERVER_URL = $serverUrl
  Write-Host "[start] OpenCode server not reachable, starting on $hostName`:$ocPort ..."
  $candidates = @()
  $envOpencode = Get-EnvValue -Key "OPENCODE_COMMAND" -Default ""
  if ($envOpencode) { $candidates += $envOpencode }
  try {
    $cmdSource = (Get-Command opencode -ErrorAction Stop).Source
    if ($cmdSource) { $candidates += $cmdSource }
  } catch {}
  $candidates += "opencode"
  $candidates = $candidates | Where-Object { $_ -and $_.Trim() -ne "" } | Select-Object -Unique

  $ocOutLog = Join-Path $logDir "opencode-serve.out.log"
  $ocErrLog = Join-Path $logDir "opencode-serve.err.log"
  if (Test-Path $ocOutLog) { Remove-Item $ocOutLog -Force -ErrorAction SilentlyContinue }
  if (Test-Path $ocErrLog) { Remove-Item $ocErrLog -Force -ErrorAction SilentlyContinue }

  $spawned = $false
  $openCodeProc = $null
  foreach ($candidate in $candidates) {
    $spawnProc = Start-OpenCodeServeProcess -CommandPath $candidate -HostName $hostName -TargetPort $ocPort -WorkDir $root -OutLog $ocOutLog -ErrLog $ocErrLog
    if ($spawnProc) {
      if ((Wait-Port -HostName $hostName -TargetPort $ocPort -Rounds 6) -and (Test-OpenCodeHealth -ServerUrl $serverUrl -TimeoutMs 4000)) {
        $spawned = $true
        $openCodeProc = $spawnProc
        break
      }
      try {
        if (-not $spawnProc.HasExited) {
          Stop-Process -Id $spawnProc.Id -Force -ErrorAction SilentlyContinue
        }
      } catch {}
    }
  }

  if ($spawned -or ((Wait-Port -HostName $hostName -TargetPort $ocPort -Rounds 20) -and (Test-OpenCodeHealth -ServerUrl $serverUrl -TimeoutMs 4000))) {
    Write-Host "[start] OpenCode server ready at $serverUrl"
  } else {
    Write-Warning "[start] OpenCode server still unhealthy at $serverUrl"
    Write-Host "[start] see logs: $ocOutLog / $ocErrLog"
  }
  }
}

$nodeOutLog = Join-Path $logDir "node-gateway.out.log"
$nodeErrLog = Join-Path $logDir "node-gateway.err.log"
if (Test-Path $nodeOutLog) { Remove-Item $nodeOutLog -Force -ErrorAction SilentlyContinue }
if (Test-Path $nodeErrLog) { Remove-Item $nodeErrLog -Force -ErrorAction SilentlyContinue }

if ($DisableAutoRestart) {
  Write-Host "[start] launching gateway sdk worker (auto restart: off) ..."
} else {
  Write-Host "[start] launching gateway sdk worker (auto restart: on) ..."
}
$nodeCmd = "node.exe"
try {
  $resolvedNode = (Get-Command node.exe -ErrorAction Stop).Source
  if ($resolvedNode) { $nodeCmd = $resolvedNode }
} catch {}

$env:NODE_GATEWAY_PORT = "$Port"
$nodeArgs = @($gatewayEntry)
if (-not $DisableAutoRestart) {
  $nodeArgs = @("--watch", $gatewayEntry)
}
$gatewayProc = Start-Process -WindowStyle Hidden -FilePath $nodeCmd -ArgumentList $nodeArgs -WorkingDirectory $root -RedirectStandardOutput $nodeOutLog -RedirectStandardError $nodeErrLog -PassThru

$openCodePid = 0
try {
  if ($openCodeProc -and -not $openCodeProc.HasExited) {
    $openCodePid = [int]$openCodeProc.Id
  }
} catch {}
Write-GatewayPidFile -FilePath $pidFile -ProjectRoot $root -GatewayPid ([int]$gatewayProc.Id) -OpenCodePid $openCodePid
Write-Host "[start] pid file updated: $pidFile (gateway=$($gatewayProc.Id), opencode=$openCodePid)"

$connectionMode = (Get-EnvValue -Key "FEISHU_CONNECTION_MODE" -Default "long_connection").ToLower()
if ($connectionMode -ne "long_connection") {
  Write-Warning "[start] FEISHU_CONNECTION_MODE=$connectionMode is not supported in sdk-only mode; expected long_connection"
}

if ($connectionMode -eq "long_connection") {
  $ready = Wait-LogPatternAll -FilePath $nodeOutLog -Patterns @(
    "[feishu] ws preflight ok",
    "[feishu] long connection started",
    "[feishu] ws startup check ok",
    "[gateway] mode=long_connection"
  ) -Rounds 45
} else {
  $ready = Wait-LogPattern -FilePath $nodeOutLog -Patterns @(
    "[gateway] mode=long_connection",
    "[feishu] long connection started",
    "[feishu] skip long connection"
  ) -Rounds 30
}
if ($gatewayProc.HasExited) {
  Write-Warning "[start] gateway process exited unexpectedly (exit=$($gatewayProc.ExitCode))"
  if (Test-Path $pidFile) { Remove-Item $pidFile -Force -ErrorAction SilentlyContinue }
  Write-Host "[start] see logs: $nodeOutLog / $nodeErrLog"
  if (Test-Path $nodeOutLog) { Get-Content -Path $nodeOutLog -Tail 80 }
  if (Test-Path $nodeErrLog) { Get-Content -Path $nodeErrLog -Tail 80 }
  exit 1
}
if (-not $ready) {
  Write-Warning "[start] gateway started but readiness log not observed yet (mode=$connectionMode)"
}
$runtimePids = Find-GatewayRuntimePids -ProjectRoot $root
$trackedGatewayPid = if ($runtimePids.Count -gt 0) { [int]$runtimePids[0] } else { [int]$gatewayProc.Id }
$extraTrackedPids = @([int]$gatewayProc.Id)
if ($runtimePids.Count -gt 1) {
  $extraTrackedPids += @($runtimePids | Select-Object -Skip 1)
}
Write-GatewayPidFile -FilePath $pidFile -ProjectRoot $root -GatewayPid $trackedGatewayPid -OpenCodePid $openCodePid -ExtraPids $extraTrackedPids
Write-Host "[start] pid file refreshed: gateway=$trackedGatewayPid extra=$($extraTrackedPids -join ',') opencode=$openCodePid"
Write-Host "[start] done."
