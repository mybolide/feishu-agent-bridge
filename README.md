# feishu-agent-bridge

Feishu bot runtime gateway based on Node.js.  
It receives Feishu long-connection events and routes requests to configured agent runtimes.

## Features

- Feishu long-connection event handling
- Runtime routing by thread-level tool selection
- Session/model persistence per thread + per tool
- Runtime/model compatibility validation and auto-fallback
- Model card pagination (browse full model list, not only first 12)
- Streaming response card updates
- Abort / abort-and-new-session operations
- Runtime providers:
  - `opencode` (integrated)
  - `iflow-cli` (integrated)
  - `gemini-cli` (reserved extension point)
  - `codex-cli` (reserved extension point)

## Integration Status

- `opencode`: integrated and available in runtime routing.
- `iflow-cli`: integrated and available in runtime routing.
- Unified provider interface is in place for adding more runtimes.

## Requirements

- Node.js `22+` (project uses `node:sqlite`)
- PowerShell (for scripts under `scripts/`)
- Feishu self-built app credentials
- Optional:
  - OpenCode CLI/server
  - iFlow CLI + auth config

## Quick Start

1. Install dependencies:

```powershell
npm install
```

2. Prepare env:

```powershell
Copy-Item .env.example .env
```

3. Fill required values in `.env`:

- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`

4. Start gateway (hot reload enabled by default):

```powershell
.\scripts\start.ps1
```

## Useful Commands

```powershell
# syntax checks used by CI/local validation
.\scripts\lint.ps1 -SkipInstall

# unit tests
npm test
```

## GitHub Publishing: What To Commit vs Not Commit

### Commit

- `gateway/**`
- `scripts/**`
- `docs/**`
- `tests/**`
- `.github/workflows/**`
- `package.json`
- `package-lock.json`
- `.env.example`
- `.gitignore`
- `README.md`
- `README.zh-CN.md`

### Do NOT Commit

- `.env` (contains secrets)
- `node_modules/`
- `logs/`
- `data.db`, `data.db-shm`, `data.db-wal`
- local temp/cache files
- any real credentials/tokens

## Security Notes

- If secrets were ever stored in `.env` and committed previously, rotate them immediately:
  - Feishu App Secret
  - Any API keys/passwords
- Keep `.env` local only; use `.env.example` for sharing config shape.

## Architecture Note

Main runtime routing logic document:

- `docs/architecture/runtime-routing-logic.md`
