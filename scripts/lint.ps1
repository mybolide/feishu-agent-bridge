param(
  [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$bootstrap = Join-Path $PSScriptRoot "bootstrap.ps1"

if (-not $SkipInstall) {
  & $bootstrap -Dev
}

Push-Location $root
try {
  node --check "gateway/main.js"
  if ($LASTEXITCODE -ne 0) { throw "node --check gateway/main.js failed (exit=$LASTEXITCODE)" }
  node --check "gateway/server/worker.js"
  if ($LASTEXITCODE -ne 0) { throw "node --check gateway/server/worker.js failed (exit=$LASTEXITCODE)" }
  node --check "gateway/server/run-service.js"
  if ($LASTEXITCODE -ne 0) { throw "node --check gateway/server/run-service.js failed (exit=$LASTEXITCODE)" }
  node --check "gateway/server/retry-policy.js"
  if ($LASTEXITCODE -ne 0) { throw "node --check gateway/server/retry-policy.js failed (exit=$LASTEXITCODE)" }
  node --check "gateway/feishu/core/runtime.js"
  if ($LASTEXITCODE -ne 0) { throw "node --check gateway/feishu/core/runtime.js failed (exit=$LASTEXITCODE)" }
  node --check "gateway/feishu/core/model-card-flow.js"
  if ($LASTEXITCODE -ne 0) { throw "node --check gateway/feishu/core/model-card-flow.js failed (exit=$LASTEXITCODE)" }
  node --check "gateway/feishu/ui/navigation.js"
  if ($LASTEXITCODE -ne 0) { throw "node --check gateway/feishu/ui/navigation.js failed (exit=$LASTEXITCODE)" }
  node --check "gateway/feishu/core/commands.js"
  if ($LASTEXITCODE -ne 0) { throw "node --check gateway/feishu/core/commands.js failed (exit=$LASTEXITCODE)" }
  node --check "gateway/feishu/ui/cards.js"
  if ($LASTEXITCODE -ne 0) { throw "node --check gateway/feishu/ui/cards.js failed (exit=$LASTEXITCODE)" }
  node --check "gateway/feishu/sdk/messenger.js"
  if ($LASTEXITCODE -ne 0) { throw "node --check gateway/feishu/sdk/messenger.js failed (exit=$LASTEXITCODE)" }
  node --check "gateway/agent-runtime/opencode/client.js"
  if ($LASTEXITCODE -ne 0) { throw "node --check gateway/agent-runtime/opencode/client.js failed (exit=$LASTEXITCODE)" }
  node --check "gateway/agent-runtime/opencode/model-catalog.js"
  if ($LASTEXITCODE -ne 0) { throw "node --check gateway/agent-runtime/opencode/model-catalog.js failed (exit=$LASTEXITCODE)" }
  node --check "gateway/agent-runtime/opencode/progress-card.js"
  if ($LASTEXITCODE -ne 0) { throw "node --check gateway/agent-runtime/opencode/progress-card.js failed (exit=$LASTEXITCODE)" }
  node --check "gateway/state/store.js"
  if ($LASTEXITCODE -ne 0) { throw "node --check gateway/state/store.js failed (exit=$LASTEXITCODE)" }
} finally {
  Pop-Location
}
