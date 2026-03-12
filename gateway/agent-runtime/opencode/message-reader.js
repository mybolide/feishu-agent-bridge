import {
  createAbortError,
  isAbortLikeError,
  isRetriableSessionReadError,
  MESSAGE_POLL_INTERVAL_MS,
  MESSAGE_POLL_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  retryDelayMs,
  SESSION_MESSAGES_RETRY_ATTEMPTS,
  SESSION_MESSAGES_RETRY_DELAY_MS,
  WAIT_FOREVER_AFTER_PROGRESS,
  withTimeout,
  extractSessionDirectory,
  sleep
} from "./client-core.js";

function extractMessageInfo(item) {
  if (!item || typeof item !== "object") {
    return {};
  }
  if (item.info && typeof item.info === "object") {
    return item.info;
  }
  return item;
}

export function extractMessageId(item) {
  const info = extractMessageInfo(item);
  return String(info.id || item?.id || "").trim();
}

export function extractMessageCreatedAt(item) {
  const info = extractMessageInfo(item);
  const time = info.time;
  if (time && typeof time === "object") {
    const created = Number(time.created || 0);
    if (Number.isFinite(created) && created > 0) {
      return created;
    }
  }
  return 0;
}

function extractMessageCompletedAt(item) {
  const info = extractMessageInfo(item);
  const time = info.time;
  if (time && typeof time === "object") {
    const completed = Number(time.completed || 0);
    if (Number.isFinite(completed) && completed > 0) {
      return completed;
    }
  }
  return 0;
}

export function messageRole(item) {
  const info = extractMessageInfo(item);
  return String(info.role || "").trim().toLowerCase();
}

export function extractTextFromParts(parts) {
  if (!Array.isArray(parts)) {
    return "";
  }
  const chunks = [];
  for (const item of parts) {
    if (!item || typeof item !== "object") {
      continue;
    }
    if (String(item.type || "") === "text" && typeof item.text === "string") {
      chunks.push(item.text);
    }
  }
  return chunks.join("").trim();
}

function latestAssistantMessage(rows, sinceCreatedAt = 0, seenMessageIds = new Set()) {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (messageRole(row) !== "assistant") {
      continue;
    }
    const messageId = extractMessageId(row);
    if (messageId && seenMessageIds.has(messageId)) {
      continue;
    }
    const createdAt = extractMessageCreatedAt(row);
    if (createdAt < sinceCreatedAt) {
      continue;
    }
    const text = extractTextFromParts(row.parts);
    const completedAt = extractMessageCompletedAt(row);
    return {
      id: messageId,
      text,
      createdAt,
      completedAt,
      completed: completedAt > 0
    };
  }
  return null;
}

function latestAssistantText(rows, sinceCreatedAt = 0, seenMessageIds = new Set()) {
  const latest = latestAssistantMessage(rows, sinceCreatedAt, seenMessageIds);
  return String(latest?.text || "");
}

export function normalizeEventPayload(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  if (raw.payload && typeof raw.payload === "object") {
    return raw.payload;
  }
  return raw;
}

export function normalizeModelPayload(model) {
  const value = String(model || "").trim();
  if (!value) {
    return undefined;
  }
  const idx = value.indexOf("/");
  if (idx <= 0 || idx === value.length - 1) {
    return undefined;
  }
  return {
    providerID: value.slice(0, idx),
    modelID: value.slice(idx + 1)
  };
}

export function toSessionRows(rawRows) {
  const rows = Array.isArray(rawRows) ? rawRows : [];
  const output = [];
  for (const item of rows) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const id = String(item.id || "").trim();
    if (!id) {
      continue;
    }
    output.push({
      id,
      title: String(item.title || ""),
      directory: extractSessionDirectory(item) || String(item.directory || "")
    });
  }
  return output;
}

async function fetchSessionMessages(client, directory, sessionId, requestOptions = {}) {
  if (requestOptions?.signal?.aborted) {
    throw createAbortError("OpenCode session.messages aborted");
  }
  const rows = await withTimeout(client.session.messages({
    sessionID: sessionId,
    directory,
    limit: 200
  }, requestOptions), REQUEST_TIMEOUT_MS, `OpenCode session.messages session=${sessionId}`, requestOptions);
  return Array.isArray(rows) ? rows.filter((item) => !!item && typeof item === "object") : [];
}

export async function fetchSessionMessagesWithRetry(client, directory, sessionId, requestOptions = {}, options = {}) {
  const maxAttempts = Math.max(1, Number(options?.maxAttempts || 0) || SESSION_MESSAGES_RETRY_ATTEMPTS);
  const baseDelayMs = Math.max(100, Number(options?.retryDelayMs || 0) || SESSION_MESSAGES_RETRY_DELAY_MS);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (requestOptions?.signal?.aborted) {
      throw createAbortError(`OpenCode session.messages session=${sessionId} aborted`);
    }
    try {
      return await fetchSessionMessages(client, directory, sessionId, requestOptions);
    } catch (error) {
      if (attempt >= maxAttempts || !isRetriableSessionReadError(error)) {
        throw error;
      }
      const delayMs = retryDelayMs(baseDelayMs, attempt);
      console.warn(`[trace][session] session.messages retry session=${sessionId} attempt=${attempt}/${maxAttempts} delayMs=${delayMs} reason=${String(error?.message || error)}`);
      await sleep(delayMs);
    }
  }
  return [];
}

export async function waitForAssistantMessage(client, directory, sessionId, sinceCreatedAt = 0, seenMessageIds = new Set(), requestOptions = {}) {
  const startedAt = Date.now();
  const baseDeadline = startedAt + MESSAGE_POLL_TIMEOUT_MS;
  const progressState = requestOptions?.progressState && typeof requestOptions.progressState === "object"
    ? requestOptions.progressState
    : null;
  let waitForeverLogged = false;
  const resolveDeadline = () => {
    const firstProgressAt = Number(progressState?.firstProgressAt || 0);
    if (WAIT_FOREVER_AFTER_PROGRESS && Number.isFinite(firstProgressAt) && firstProgressAt > 0) {
      if (!waitForeverLogged) {
        waitForeverLogged = true;
        console.log(`[trace][session] waitForAssistantMessage wait-forever enabled directory=${directory} session=${sessionId}`);
      }
      return Number.POSITIVE_INFINITY;
    }
    const lastProgressAt = Number(progressState?.lastProgressAt || 0);
    if (!Number.isFinite(lastProgressAt) || lastProgressAt <= 0) {
      return baseDeadline;
    }
    return Math.max(baseDeadline, lastProgressAt + MESSAGE_POLL_TIMEOUT_MS);
  };
  let polls = 0;
  let transientFailures = 0;
  while (Date.now() <= resolveDeadline()) {
    if (requestOptions?.signal?.aborted) {
      throw createAbortError("OpenCode waitForAssistantMessage aborted");
    }
    let rows = [];
    try {
      rows = await fetchSessionMessagesWithRetry(client, directory, sessionId, requestOptions);
      transientFailures = 0;
    } catch (error) {
      if (isAbortLikeError(error)) {
        throw error;
      }
      if (!isRetriableSessionReadError(error)) {
        throw error;
      }
      transientFailures += 1;
      const delayMs = retryDelayMs(SESSION_MESSAGES_RETRY_DELAY_MS, transientFailures);
      if (transientFailures === 1 || transientFailures % SESSION_MESSAGES_RETRY_ATTEMPTS === 0) {
        console.warn(`[trace][session] waitForAssistantMessage transient-failure directory=${directory} session=${sessionId} count=${transientFailures} delayMs=${delayMs} reason=${String(error?.message || error)}`);
      }
      await sleep(delayMs);
      continue;
    }
    polls += 1;
    const output = latestAssistantText(rows, sinceCreatedAt, seenMessageIds);
    if (output) {
      if (progressState) {
        const now = Date.now();
        progressState.lastProgressAt = now;
        if (!progressState.firstProgressAt) {
          progressState.firstProgressAt = now;
        }
      }
      console.log(`[trace][session] waitForAssistantMessage hit directory=${directory} session=${sessionId} polls=${polls} elapsedMs=${Date.now() - startedAt} outputLen=${output.length}`);
      return output;
    }
    await sleep(MESSAGE_POLL_INTERVAL_MS);
  }
  const sinceProgressMs = Number(progressState?.lastProgressAt || 0) > 0
    ? Date.now() - Number(progressState.lastProgressAt)
    : -1;
  throw new Error(`OpenCode 消息轮询超时（>${MESSAGE_POLL_TIMEOUT_MS}ms）${sinceProgressMs >= 0 ? `，距最近进度 ${sinceProgressMs}ms` : ""}`);
}

export function readLatestAssistantProgress(rows, sinceCreatedAt = 0, seenMessageIds = new Set()) {
  const latest = latestAssistantMessage(rows, sinceCreatedAt, seenMessageIds);
  return {
    messageId: String(latest?.id || ""),
    text: String(latest?.text || ""),
    completed: Boolean(latest?.completed)
  };
}
