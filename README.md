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
  - `opencode` (integrated) - OpenCode SDK
  - `iflow-cli` (integrated) - iFlow CLI
  - `claude` (integrated) - Claude Code SDK with Bailian Coding Plan
  - `gemini-cli` (integrated) - Gemini CLI
  - `codex-cli` (reserved extension point)

## Integration Status

- `opencode`: integrated and available in runtime routing.
- `iflow-cli`: integrated and available in runtime routing.
- `claude`: integrated with Bailian Coding Plan API support. Models: qwen3.5-plus, glm-5, kimi-k2.5, MiniMax-M2.5.
- `gemini-cli`: integrated with Google OAuth / API Key. Models: gemini-2.5-pro, gemini-2.5-flash, gemini-2.0-flash.
- Unified provider interface is in place for adding more runtimes.

## Requirements

- Node.js `22+` (project uses `node:sqlite`)
- PowerShell (for scripts under `scripts/`)
- Feishu self-built app credentials
- Optional:
  - OpenCode CLI/server
  - iFlow CLI + auth config
  - Claude Code CLI + Bailian Coding Plan API key
  - Gemini CLI + Google OAuth or API Key

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

4. (Optional) Configure Claude Code SDK for Bailian Coding Plan:

- `CLAUDE_AUTH_TOKEN` - Your Bailian Coding Plan API key
- `CLAUDE_BASE_URL` - API endpoint (default: `https://coding.dashscope.aliyuncs.com/apps/anthropic`)

5. Start gateway (hot reload enabled by default):

```powershell
.\scripts\start.ps1
```

## Usage

Switch runtime in Feishu chat:

```
/oc tool opencode    # Use OpenCode SDK
/oc tool iflow-cli   # Use iFlow CLI
/oc tool claude      # Use Claude Code SDK (Bailian)
/oc tool gemini-cli  # Use Gemini CLI
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
