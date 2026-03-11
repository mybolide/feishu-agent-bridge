export function isIFlowFirstTokenTimeoutError(error) {
  const message = String(error?.message || error || "").trim();
  if (!message) {
    return false;
  }
  return message.includes("iFlow receive message")
    && message.includes("firstToken=0")
    && message.includes("timeout after");
}

export function isIFlowSessionStateRetryableError(error) {
  const message = String(error?.message || error || "").trim().toLowerCase();
  if (!message) {
    return false;
  }
  return message.includes("not currently generating");
}

export function isOpenCodeFirstTokenTimeoutError(error) {
  const message = String(error?.message || error || "").trim().toLowerCase();
  if (!message) {
    return false;
  }
  return message.includes("opencode 消息轮询超时")
    || message.includes("opencode message polling timeout");
}

function isEnvEnabled(key, fallback = false) {
  const value = String(process.env[key] ?? "").trim().toLowerCase();
  if (!value) {
    return fallback;
  }
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

export function shouldRetryInCurrentSession({ runtimeId, error, attempt, aborted }) {
  const runtime = String(runtimeId || "").trim().toLowerCase();
  if (runtime !== "iflow-cli") {
    return false;
  }
  if (aborted) {
    return false;
  }
  if (Number(attempt || 0) > 0) {
    return false;
  }
  return isIFlowSessionStateRetryableError(error);
}

export function shouldRetryWithFreshSession({ runtimeId, error, attempt, aborted }) {
  const runtime = String(runtimeId || "").trim().toLowerCase();
  if (aborted) {
    return false;
  }
  if (Number(attempt || 0) > 0) {
    return false;
  }
  if (runtime === "iflow-cli") {
    return isIFlowFirstTokenTimeoutError(error);
  }
  if (runtime === "opencode") {
    if (!isEnvEnabled("OPENCODE_TIMEOUT_RETRY_ENABLED", false)) {
      return false;
    }
    return isOpenCodeFirstTokenTimeoutError(error);
  }
  return false;
}
