import { query, listSessions, forkSession, getSessionInfo, getSessionMessages, AbortError } from "@anthropic-ai/claude-agent-sdk";
import { config } from "../../config/index.js";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_MODEL = "qwen3.5-plus";
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const LOG_FILE = path.join(process.cwd(), "logs", "claude-sdk.log");

// 确保日志目录存在
function ensureLogDir() {
  const dir = path.dirname(LOG_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function log(msg) {
  ensureLogDir();
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFileSync(LOG_FILE, line);
  // 同时输出到 console
  console.log(line.trim());
}

function getBailianEnv() {
  const env = {};
  // 从项目配置中获取百炼 API 配置
  if (config.claudeAuthToken) {
    env.ANTHROPIC_AUTH_TOKEN = config.claudeAuthToken;
  }
  if (config.claudeBaseUrl) {
    env.ANTHROPIC_BASE_URL = config.claudeBaseUrl;
  }
  return env;
}

function normalizeDirectory(raw) {
  const value = String(raw || "").trim();
  if (!value) {
    return process.cwd();
  }
  return value;
}

function isAbortLikeError(error) {
  if (!error) {
    return false;
  }
  if (error instanceof AbortError) {
    return true;
  }
  const name = String(error?.name || "").trim().toLowerCase();
  const message = String(error?.message || error || "").trim().toLowerCase();
  return name === "aborterror" || message.includes("abort") || message.includes("aborted");
}

function extractAssistantText(message) {
  if (!message || message.type !== "assistant") {
    return "";
  }
  const content = message.message?.content;
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text || "")
    .join("")
    .trim();
}

function extractErrorFromResult(result) {
  if (!result || result.type !== "result") {
    return null;
  }
  if (result.subtype === "success") {
    return null;
  }
  // Error subtypes: error_max_turns, error_during_execution, error_max_budget_usd, etc.
  const errors = result.errors || [];
  const errorMessage = errors.length > 0 ? errors.join("; ") : result.subtype || "Unknown error";
  return {
    name: result.subtype || "UnknownError",
    message: errorMessage,
    is_error: true
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms || 0)));
}

export function createClaudeClient() {
  return {
    query,
    listSessions,
    forkSession,
    getSessionInfo,
    getSessionMessages
  };
}

export async function listClaudeSessions(directory) {
  const normalizedDir = normalizeDirectory(directory);
  try {
    const sessions = await listSessions({ dir: normalizedDir });
    return Array.isArray(sessions) ? sessions.map((s) => ({
      id: s.session_id || s.id || "",
      title: s.summary || s.title || "",
      directory: normalizedDir,
      createdAt: s.created_at || s.createdAt || 0
    })) : [];
  } catch (error) {
    console.warn(`[claude] listSessions failed: ${error.message}`);
    return [];
  }
}

export async function createClaudeSession(directory, title) {
  // Claude Code SDK doesn't have explicit session creation.
  // Sessions are created implicitly when sending the first message.
  // We return a placeholder that will be replaced after the first message.
  const normalizedDir = normalizeDirectory(directory);
  return {
    id: "",  // Will be set after first message
    title: title || `claude-${Date.now()}`,
    directory: normalizedDir
  };
}

export async function sendClaudeMessage(directory, sessionId, text, model, options = {}) {
  const normalizedDir = normalizeDirectory(directory);
  const effectiveModel = String(model || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const abortController = options?.signal ? new AbortController() : new AbortController();

  // Link external abort signal if provided
  if (options?.signal) {
    if (options.signal.aborted) {
      abortController.abort();
    } else {
      options.signal.addEventListener("abort", () => abortController.abort(), { once: true });
    }
  }

  const queryOptions = {
    model: effectiveModel,
    cwd: normalizedDir,
    permissionMode: "bypassPermissions",  // 跳过所有权限检查
    allowDangerouslySkipPermissions: true,  // 安全确认
    abortController,
    env: {
      ...getBailianEnv(),
      // 保留其他必要的环境变量
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_TELEMETRY: "1"
    }
  };

  // Resume existing session if sessionId is provided
  if (sessionId) {
    queryOptions.resume = sessionId;
  }

  const startedAt = Date.now();
  let firstProgressAt = 0;
  let output = "";
  let resultSessionId = sessionId || "";
  let error = null;
  let completed = false;

  const onProgress = typeof options?.onProgress === "function" ? options.onProgress : null;

  try {
    const q = query({
      prompt: text,
      options: queryOptions
    });

    for await (const message of q) {
      if (abortController.signal.aborted) {
        break;
      }

      // Extract session ID from any message that has it
      if (message.session_id) {
        resultSessionId = message.session_id;
      }

      // Handle assistant messages (streaming text)
      if (message.type === "assistant") {
        const assistantText = extractAssistantText(message);
        if (assistantText) {
          if (!firstProgressAt) {
            firstProgressAt = Date.now();
            console.log(`[claude] first-progress session=${resultSessionId} ttfbMs=${firstProgressAt - startedAt}`);
          }
          output = assistantText;
          if (onProgress) {
            await onProgress({
              text: assistantText,
              completed: false
            });
          }
        }
      }

      // Handle result message (completion)
      if (message.type === "result") {
        completed = true;
        resultSessionId = message.session_id || resultSessionId;

        // Check for errors
        const resultError = extractErrorFromResult(message);
        if (resultError) {
          error = resultError;
          console.warn(`[claude] result error session=${resultSessionId} subtype=${message.subtype}`);
        } else {
          // Success - get the result text
          output = message.result || output;
        }

        if (onProgress) {
          await onProgress({
            text: output,
            completed: true,
            error: error
          });
        }

        console.log(`[claude] completed session=${resultSessionId} elapsedMs=${Date.now() - startedAt} turns=${message.num_turns || 0} cost=${message.total_cost_usd || 0}`);
      }
    }
  } catch (err) {
    if (isAbortLikeError(err)) {
      console.log(`[claude] aborted session=${resultSessionId}`);
      error = { name: "AbortedError", message: "Request aborted" };
    } else {
      console.error(`[claude] error session=${resultSessionId}`, err);
      error = {
        name: err.name || "UnknownError",
        message: err.message || String(err)
      };
    }
  }

  // 记录最终返回结果
  log(`[claude] sendMessage result: sessionId=${resultSessionId || 'MISSING'} output.length=${output.length} error=${error ? error.name : 'none'}`);

  return {
    output,
    sessionId: resultSessionId,
    error,
    completed
  };
}

export async function abortClaudeSession(directory, sessionId) {
  // Claude Code SDK doesn't have explicit session abort.
  // Sessions are aborted via AbortController in the query.
  console.log(`[claude] abort session=${sessionId} (no-op, use AbortController)`);
}

export { isAbortLikeError, extractAssistantText, extractErrorFromResult };