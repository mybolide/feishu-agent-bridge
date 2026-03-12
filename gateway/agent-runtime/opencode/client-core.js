import fs from "node:fs";
import path from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { config } from "../../config/index.js";
import { createOpencodeResolvedFetch } from "./server-discovery.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MESSAGE_POLL_INTERVAL_MS = 2000;
const DEFAULT_MESSAGE_POLL_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_SESSION_LIST_TIMEOUT_MS = 45 * 1000;
const DEFAULT_STREAM_PROGRESS_INTERVAL_MS = 1200;
const DEFAULT_EVENT_STREAM_RETRY_DELAY_MS = 1200;
const DEFAULT_SESSION_LIST_RETRY_ATTEMPTS = 3;
const DEFAULT_SESSION_LIST_RETRY_DELAY_MS = 800;
const DEFAULT_SESSION_MESSAGES_RETRY_ATTEMPTS = 3;
const DEFAULT_SESSION_MESSAGES_RETRY_DELAY_MS = 600;
const MAX_RETRY_DELAY_MS = 5000;

function safeInt(raw, fallback) {
  const value = Number.parseInt(String(raw || "").trim(), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function parseBoolean(raw, fallback = false) {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value) {
    return fallback;
  }
  if (["1", "true", "yes", "on"].includes(value)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(value)) {
    return false;
  }
  return fallback;
}

export const REQUEST_TIMEOUT_MS = safeInt(process.env.OPENCODE_REQUEST_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS);
export const MESSAGE_POLL_INTERVAL_MS = safeInt(process.env.OPENCODE_MESSAGE_POLL_INTERVAL_MS, DEFAULT_MESSAGE_POLL_INTERVAL_MS);
export const MESSAGE_POLL_TIMEOUT_MS = safeInt(process.env.OPENCODE_MESSAGE_POLL_TIMEOUT_MS, DEFAULT_MESSAGE_POLL_TIMEOUT_MS);
export const WAIT_FOREVER_AFTER_PROGRESS = parseBoolean(process.env.OPENCODE_WAIT_FOREVER_AFTER_PROGRESS, true);
export const SESSION_LIST_TIMEOUT_MS = safeInt(process.env.OPENCODE_SESSION_LIST_TIMEOUT_MS, DEFAULT_SESSION_LIST_TIMEOUT_MS);
export const STREAM_PROGRESS_INTERVAL_MS = safeInt(process.env.OPENCODE_STREAM_PROGRESS_INTERVAL_MS, DEFAULT_STREAM_PROGRESS_INTERVAL_MS);
export const EVENT_STREAM_RETRY_DELAY_MS = safeInt(process.env.OPENCODE_EVENT_STREAM_RETRY_DELAY_MS, DEFAULT_EVENT_STREAM_RETRY_DELAY_MS);
export const SESSION_LIST_RETRY_ATTEMPTS = safeInt(process.env.OPENCODE_SESSION_LIST_RETRY_ATTEMPTS, DEFAULT_SESSION_LIST_RETRY_ATTEMPTS);
export const SESSION_LIST_RETRY_DELAY_MS = safeInt(process.env.OPENCODE_SESSION_LIST_RETRY_DELAY_MS, DEFAULT_SESSION_LIST_RETRY_DELAY_MS);
export const SESSION_MESSAGES_RETRY_ATTEMPTS = safeInt(process.env.OPENCODE_SESSION_MESSAGES_RETRY_ATTEMPTS, DEFAULT_SESSION_MESSAGES_RETRY_ATTEMPTS);
export const SESSION_MESSAGES_RETRY_DELAY_MS = safeInt(process.env.OPENCODE_SESSION_MESSAGES_RETRY_DELAY_MS, DEFAULT_SESSION_MESSAGES_RETRY_DELAY_MS);

const OPENCODE_FETCH = createOpencodeResolvedFetch();

export function createAbortError(message = "operation aborted") {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

export function isAbortLikeError(error) {
  if (!error) {
    return false;
  }
  const name = String(error?.name || "").trim().toLowerCase();
  const message = String(error?.message || error || "").trim().toLowerCase();
  return name === "aborterror"
    || message.includes("abort")
    || message.includes("aborted")
    || message.includes("cancelled");
}

function readErrorCode(error) {
  const direct = String(error?.code || "").trim();
  if (direct) {
    return direct.toUpperCase();
  }
  const cause = error?.cause;
  if (cause && typeof cause === "object" && cause !== error) {
    return readErrorCode(cause);
  }
  return "";
}

export function isRetriableSessionReadError(error) {
  if (!error || isAbortLikeError(error)) {
    return false;
  }
  const code = readErrorCode(error);
  if ([
    "ECONNRESET",
    "ETIMEDOUT",
    "ECONNREFUSED",
    "EPIPE",
    "EAI_AGAIN",
    "ENOTFOUND",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_SOCKET"
  ].includes(code)) {
    return true;
  }
  const message = String(error?.message || error || "").trim().toLowerCase();
  return message.includes("fetch failed")
    || message.includes("timeout after")
    || message.includes("socket hang up")
    || message.includes("connection reset")
    || message.includes("network");
}

export function retryDelayMs(baseDelayMs, attempt) {
  const base = Math.max(100, Number(baseDelayMs || 0) || 500);
  return Math.min(MAX_RETRY_DELAY_MS, base * Math.max(1, Number(attempt || 1)));
}

function getServerAuthHeader() {
  const username = String(process.env.OPENCODE_SERVER_USERNAME || "opencode").trim() || "opencode";
  const password = String(process.env.OPENCODE_SERVER_PASSWORD || "").trim();
  if (!password) {
    return "";
  }
  const token = Buffer.from(`${username}:${password}`, "utf-8").toString("base64");
  return `Basic ${token}`;
}

export function normalizeDirectory(raw) {
  const value = String(raw || "").trim();
  if (!value) {
    return "";
  }
  let resolved = /^[A-Za-z]:[\\/]/.test(value) ? value : path.resolve(value);
  try {
    const realpath = fs.realpathSync.native || fs.realpathSync;
    resolved = realpath(resolved);
  } catch {
    // keep resolved path when realpath is unavailable
  }
  if (process.platform === "win32") {
    let normalizedWin = path.win32.normalize(String(resolved || ""));
    if (/^[a-z]:\\/.test(normalizedWin)) {
      normalizedWin = `${normalizedWin[0].toUpperCase()}${normalizedWin.slice(1)}`;
    }
    return normalizedWin;
  }
  let normalized = path.posix.normalize(String(resolved || "").replace(/\\/g, "/"));
  if (/^[a-z]:\//.test(normalized)) {
    normalized = `${normalized[0].toUpperCase()}${normalized.slice(1)}`;
  }
  return normalized;
}

export function extractSessionDirectory(item) {
  const direct = ["directory", "cwd", "path", "project_path", "projectPath"];
  for (const key of direct) {
    const value = String(item?.[key] || "").trim();
    if (value) {
      return value;
    }
  }
  const project = item?.project;
  if (project && typeof project === "object") {
    for (const key of ["path", "cwd", "directory"]) {
      const value = String(project[key] || "").trim();
      if (value) {
        return value;
      }
    }
  }
  return "";
}

export function withTimeout(promise, timeoutMs, label, options = {}) {
  const ms = Math.max(1000, Number(timeoutMs || 0) || REQUEST_TIMEOUT_MS);
  let timer = null;
  const signal = options?.signal;
  let abortHandler = null;
  if (signal?.aborted) {
    return Promise.reject(createAbortError(`${label} aborted before start`));
  }
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timeout after ${ms}ms`));
    }, ms);
    if (signal) {
      abortHandler = () => reject(createAbortError(`${label} aborted`));
      signal.addEventListener("abort", abortHandler, { once: true });
    }
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
    if (signal && abortHandler) {
      signal.removeEventListener("abort", abortHandler);
    }
  });
}

export function createSdkClient(directory) {
  const authHeader = getServerAuthHeader();
  return createOpencodeClient({
    baseUrl: config.opencodeServerUrl,
    fetch: OPENCODE_FETCH,
    responseStyle: "data",
    throwOnError: true,
    ...(directory ? { directory } : {}),
    ...(authHeader ? { headers: { Authorization: authHeader } } : {})
  });
}

export function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms || 0));
  });
}
