import { spawn } from "child_process";
import { randomUUID } from "crypto";

const DEFAULT_MODEL = "gemini-2.5-flash";
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

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
  const name = String(error?.name || "").trim().toLowerCase();
  const message = String(error?.message || error || "").trim().toLowerCase();
  return name === "aborterror" || message.includes("abort") || message.includes("aborted");
}

function parseStreamJsonLine(line) {
  if (!line || typeof line !== "string") {
    return null;
  }
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function extractTextFromEvent(event) {
  if (!event || typeof event !== "object") {
    return "";
  }
  // Gemini CLI stream-json 事件格式
  if (event.type === "content" && event.text) {
    return event.text;
  }
  if (event.type === "response" && event.content) {
    return event.content;
  }
  if (event.response?.text) {
    return event.response.text;
  }
  if (event.result) {
    return String(event.result);
  }
  return "";
}

function extractErrorFromEvent(event) {
  if (!event || typeof event !== "object") {
    return null;
  }
  if (event.type === "error" || event.error) {
    const errorInfo = event.error || event;
    return {
      name: errorInfo.code || errorInfo.name || "GeminiError",
      message: errorInfo.message || String(errorInfo)
    };
  }
  return null;
}

export function createGeminiClient() {
  return {
    spawnGemini: (args, options = {}) => {
      const geminiPath = options.geminiPath || "gemini";
      const cwd = options.cwd || process.cwd();
      const env = {
        ...process.env,
        ...options.env
      };
      
      return spawn(geminiPath, args, {
        cwd,
        env,
        shell: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
    }
  };
}

export async function listGeminiSessions(directory) {
  // Gemini CLI 没有显式的会话列表 API
  // 会话通过 checkpoint 功能管理
  return [];
}

export async function createGeminiSession(directory, title) {
  const normalizedDir = normalizeDirectory(directory);
  return {
    id: randomUUID(),
    title: title || `gemini-${Date.now()}`,
    directory: normalizedDir
  };
}

export async function sendGeminiMessage(directory, sessionId, text, model, options = {}) {
  const normalizedDir = normalizeDirectory(directory);
  const effectiveModel = String(model || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  
  const args = [
    "--output-format", "stream-json",
    "--approval-mode", "yolo",  // 自动批准所有操作
    "-m", effectiveModel,
    "-p", text
  ];
  
  const startedAt = Date.now();
  let firstProgressAt = 0;
  let output = "";
  let error = null;
  let completed = false;

  const onProgress = typeof options?.onProgress === "function" ? options.onProgress : null;
  const abortSignal = options?.signal;

  return new Promise((resolve, reject) => {
    const gemini = spawn("gemini", args, {
      cwd: normalizedDir,
      shell: true,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    const timeout = setTimeout(() => {
      gemini.kill();
      error = { name: "TimeoutError", message: "Request timeout" };
      completed = true;
      resolve({ output, sessionId, error, completed });
    }, REQUEST_TIMEOUT_MS);

    if (abortSignal) {
      if (abortSignal.aborted) {
        clearTimeout(timeout);
        gemini.kill();
        resolve({ output, sessionId, error: { name: "AbortedError", message: "Request aborted" }, completed: false });
        return;
      }
      abortSignal.addEventListener("abort", () => {
        clearTimeout(timeout);
        gemini.kill();
        resolve({ output, sessionId, error: { name: "AbortedError", message: "Request aborted" }, completed: false });
      }, { once: true });
    }

    gemini.stdout.on("data", (data) => {
      stdout += data.toString();
      
      // 解析 stream-json 输出
      const lines = stdout.split("\n");
      for (const line of lines) {
        const event = parseStreamJsonLine(line);
        if (!event) continue;

        const eventText = extractTextFromEvent(event);
        if (eventText) {
          if (!firstProgressAt) {
            firstProgressAt = Date.now();
            console.log(`[gemini] first-progress ttfbMs=${firstProgressAt - startedAt}`);
          }
          output = eventText;
          if (onProgress) {
            onProgress({ text: eventText, completed: false });
          }
        }

        const eventError = extractErrorFromEvent(event);
        if (eventError) {
          error = eventError;
          console.warn(`[gemini] error: ${eventError.name} - ${eventError.message}`);
        }

        if (event.type === "result" || event.type === "complete" || event.done) {
          completed = true;
          if (event.result && typeof event.result === "string") {
            output = event.result;
          }
        }
      }
    });

    gemini.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    gemini.on("close", (code) => {
      clearTimeout(timeout);
      
      // 如果没有解析到 stream-json，尝试直接读取输出
      if (!output && stdout.trim()) {
        // 尝试解析整个 JSON
        try {
          const parsed = JSON.parse(stdout.trim());
          output = parsed.result || parsed.response?.text || parsed.content || stdout.trim();
          completed = true;
        } catch {
          // 不是 JSON，直接使用文本
          output = stdout.trim();
          completed = true;
        }
      }

      if (code !== 0 && !error) {
        const errorMsg = stderr.trim() || `Process exited with code ${code}`;
        error = { name: "ProcessError", message: errorMsg };
      }

      if (onProgress) {
        onProgress({ text: output, completed: true, error });
      }

      console.log(`[gemini] completed elapsedMs=${Date.now() - startedAt} code=${code}`);
      resolve({ output, sessionId, error, completed });
    });

    gemini.on("error", (err) => {
      clearTimeout(timeout);
      error = { name: err.name || "SpawnError", message: err.message };
      resolve({ output, sessionId, error, completed: false });
    });
  });
}

export async function abortGeminiSession(directory, sessionId) {
  // Gemini CLI 会话通过终止进程来中止
  console.log(`[gemini] abort session=${sessionId}`);
}

export { isAbortLikeError, extractTextFromEvent, extractErrorFromEvent };