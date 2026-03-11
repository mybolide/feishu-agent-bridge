import fs from "node:fs";
import path from "node:path";

const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MODEL_CACHE_TTL_MS = 30 * 1000;
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 1000;
const DEFAULT_IDLE_DISCONNECT_MS = 20 * 60 * 1000;

function safeInt(raw, fallback) {
  const value = Number.parseInt(String(raw || "").trim(), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export const REQUEST_TIMEOUT_MS = safeInt(process.env.IFLOW_REQUEST_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS);
export const MODEL_CACHE_TTL_MS = safeInt(process.env.IFLOW_MODEL_CACHE_TTL_MS, DEFAULT_MODEL_CACHE_TTL_MS);
export const CLIENT_CLEANUP_INTERVAL_MS = safeInt(
  process.env.IFLOW_CLIENT_CLEANUP_INTERVAL_MS,
  DEFAULT_CLEANUP_INTERVAL_MS
);
export const CLIENT_IDLE_DISCONNECT_MS = safeInt(
  process.env.IFLOW_CLIENT_IDLE_DISCONNECT_MS,
  DEFAULT_IDLE_DISCONNECT_MS
);

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
    || message.includes("cancelled")
    || message.includes("interrupted");
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
  return process.platform === "win32"
    ? path.win32.normalize(resolved)
    : path.posix.normalize(String(resolved).replace(/\\/g, "/"));
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

export function parseModelId(model) {
  const value = String(model || "").trim();
  if (!value) {
    return "";
  }
  if (value.startsWith("iflow-cli/")) {
    return value.slice("iflow-cli/".length);
  }
  if (value.includes("/")) {
    return value.slice(value.lastIndexOf("/") + 1);
  }
  return value;
}

export function buildAskUserAnswers(questions) {
  const output = {};
  for (const item of Array.isArray(questions) ? questions : []) {
    const question = String(item?.question || "").trim();
    const header = String(item?.header || "").trim();
    const firstOption = String(item?.options?.[0]?.label || "").trim();
    const fallback = "继续";
    const answer = firstOption || fallback;
    if (question) {
      output[question] = answer;
    }
    if (header && header !== question) {
      output[header] = answer;
    }
  }
  return output;
}
