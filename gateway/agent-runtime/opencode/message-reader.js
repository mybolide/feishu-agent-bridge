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

export function extractQuestionRequestId(item) {
  return String(item?.id || "").trim();
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

function extractMessageFinish(item) {
  const info = extractMessageInfo(item);
  return String(info.finish || item?.finish || "").trim().toLowerCase();
}

function extractMessageError(item) {
  const info = extractMessageInfo(item);
  const error = info?.error;
  if (!error || typeof error !== "object") {
    return null;
  }
  const name = String(error.name || "").trim();
  const message = String(error?.data?.message || error?.message || "").trim();
  if (!name && !message) {
    return null;
  }
  return { name, message };
}

function isTerminalAssistantMessage(candidate) {
  // finish === "error" 或有 error 字段时直接认为 terminal
  if (candidate?.finish === "error" || candidate?.error) {
    return true;
  }
  if (!candidate?.completed) {
    return false;
  }
  return candidate.finish !== "tool-calls";
}

function isDisplayCompleteAssistantMessage(candidate) {
  if (!candidate || typeof candidate !== "object") {
    return false;
  }
  if (candidate.terminal) {
    return true;
  }
  // finish === "error" 或有 error 字段时认为完成
  if (candidate.finish === "error" || candidate.error) {
    return true;
  }
  return candidate.finish === "stop" && Boolean(String(candidate.text || "").trim());
}

export function messageRole(item) {
  const info = extractMessageInfo(item);
  return String(info.role || "").trim().toLowerCase();
}

function extractToolText(item) {
  if (!item || typeof item !== "object" || String(item.type || "") !== "tool") {
    return "";
  }
  const state = item.state && typeof item.state === "object" ? item.state : {};
  const title = String(state.title || "").trim();
  const filePath = String(state?.input?.filePath || state?.metadata?.filepath || state?.input?.path || "").trim();
  const command = String(state?.input?.command || "").trim();
  const description = String(state?.input?.description || state?.metadata?.description || "").trim();
  const output = String(state?.output || state?.metadata?.output || "").replace(/\r\n/g, "\n").trim();
  const label = title || filePath || description || command || String(item.tool || "").trim();
  return [label, output].filter(Boolean).join("\n\n").trim();
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
    const type = String(item.type || "").trim();
    if ((type === "text" || type === "reasoning") && typeof item.text === "string") {
      const text = item.text.trim();
      if (text) {
        chunks.push(text);
      }
      continue;
    }
    if (type === "tool") {
      const toolText = extractToolText(item);
      if (toolText) {
        chunks.push(toolText);
      }
    }
  }
  return chunks.join("\n\n").trim();
}

function latestAssistantMessage(rows, sinceCreatedAt = 0, seenMessageIds = new Set()) {
  let fallback = null;
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
    const finish = extractMessageFinish(row);
    const error = extractMessageError(row);
    const candidate = {
      id: messageId,
      text,
      error,
      createdAt,
      completedAt,
      completed: completedAt > 0 || finish === "error",
      finish,
      terminal: isTerminalAssistantMessage({
        completed: completedAt > 0 || finish === "error",
        finish,
        error
      })
    };
    if (candidate.terminal || candidate.text) {
      return candidate;
    }
    if (!fallback) {
      fallback = candidate;
    }
  }
  return fallback;
}

function latestAssistantText(rows, sinceCreatedAt = 0, seenMessageIds = new Set()) {
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
    if (text) {
      return text;
    }
  }
  return "";
}

function resolveAssistantSnapshotText(latestMessage, visibleText) {
  const directText = String(latestMessage?.text || "").trim();
  if (directText) {
    return directText;
  }
  return String(visibleText || "").trim();
}

function buildAssistantSnapshotKey(snapshot) {
  const text = String(snapshot?.text || "").trim();
  return JSON.stringify({
    messageId: String(snapshot?.messageId || ""),
    requestId: String(snapshot?.requestId || ""),
    finish: String(snapshot?.messageFinish || ""),
    completed: Boolean(snapshot?.messageCompleted),
    terminal: Boolean(snapshot?.messageTerminal),
    hasQuestion: Boolean(snapshot?.hasQuestion),
    text: text.slice(-160)
  });
}

export function computeAssistantWaitDeadline(startedAt, progressState = null, activityState = null) {
  const baseDeadline = Number(startedAt || 0) + MESSAGE_POLL_TIMEOUT_MS;
  const firstProgressAt = Number(progressState?.firstProgressAt || 0);
  const lastProgressAt = Number(progressState?.lastProgressAt || 0);
  const lastObservedAt = Number(activityState?.lastObservedAt || 0);
  const lastActivityAt = Math.max(firstProgressAt, lastProgressAt, lastObservedAt, 0);
  if (WAIT_FOREVER_AFTER_PROGRESS && firstProgressAt > 0) {
    return Number.POSITIVE_INFINITY;
  }
  if (lastActivityAt > 0) {
    return Math.max(baseDeadline, lastActivityAt + MESSAGE_POLL_TIMEOUT_MS);
  }
  return baseDeadline;
}

function normalizeQuestionRows(rawRows) {
  return Array.isArray(rawRows) ? rawRows.filter((item) => !!item && typeof item === "object") : [];
}

function latestPendingQuestion(rows, sessionId = "", seenQuestionIds = new Set()) {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    const requestId = extractQuestionRequestId(row);
    if (!requestId || seenQuestionIds.has(requestId)) {
      continue;
    }
    if (sessionId && String(row?.sessionID || "").trim() !== sessionId) {
      continue;
    }
    return row;
  }
  return null;
}

export function formatQuestionRequestText(request) {
  const questions = Array.isArray(request?.questions) ? request.questions : [];
  const lines = [];
  for (let index = 0; index < questions.length; index += 1) {
    const item = questions[index];
    const question = String(item?.question || "").trim();
    const header = String(item?.header || "").trim();
    const labels = (Array.isArray(item?.options) ? item.options : [])
      .map((option) => String(option?.label || "").trim())
      .filter(Boolean);
    const title = header && question && header !== question
      ? `${header}: ${question}`
      : (question || header);
    if (title) {
      lines.push(`${index + 1}. ${title}`);
    }
    if (labels.length > 0) {
      lines.push(`选项: ${labels.join(" / ")}`);
    }
  }
  return lines.join("\n").trim();
}

function formatErrorMessage(error) {
  if (!error || typeof error !== "object") {
    return "";
  }
  const name = String(error.name || "").trim();
  const message = String(error.message || "").trim();
  if (!name && !message) {
    return "";
  }
  // 友好化错误名称
  let errorLabel = "错误";
  if (name === "MessageOutputLengthError") {
    errorLabel = "Token 超出限制";
  } else if (name === "ProviderAuthError") {
    errorLabel = "认证错误";
  } else if (name === "ApiError") {
    errorLabel = "API 错误";
  } else if (name === "MessageAbortedError") {
    errorLabel = "任务已中止";
  } else if (name) {
    errorLabel = name;
  }
  return message ? `❌ ${errorLabel}: ${message}` : `❌ ${errorLabel}`;
}

function combineAssistantSnapshot(text, questionText, error) {
  const chunks = [String(text || "").trim()];
  const errorText = formatErrorMessage(error);
  if (errorText) {
    chunks.push(errorText);
  }
  chunks.push(String(questionText || "").trim());
  return chunks.filter(Boolean).join("\n\n").trim();
}

export function readLatestAssistantResponse(rows, questionRows, sessionId = "", sinceCreatedAt = 0, seenMessageIds = new Set(), seenQuestionIds = new Set()) {
  const latestMessage = latestAssistantMessage(rows, sinceCreatedAt, seenMessageIds);
  const latestVisibleText = latestAssistantText(rows, sinceCreatedAt, seenMessageIds);
  const latestQuestion = latestPendingQuestion(questionRows, sessionId, seenQuestionIds);
  const latestText = resolveAssistantSnapshotText(latestMessage, latestVisibleText);
  const questionText = latestQuestion ? formatQuestionRequestText(latestQuestion) : "";
  const messageError = latestMessage?.error || null;
  const messageDisplayComplete = isDisplayCompleteAssistantMessage({
    ...latestMessage,
    text: latestText
  });
  return {
    messageId: String(latestMessage?.id || ""),
    requestId: String(latestQuestion?.id || ""),
    text: combineAssistantSnapshot(latestText, questionText, messageError),
    completed: Boolean(questionText || messageDisplayComplete || messageError),
    hasQuestion: Boolean(questionText),
    messageCompleted: Boolean(latestMessage?.completed),
    messageTerminal: Boolean(messageDisplayComplete),
    messageFinish: String(latestMessage?.finish || ""),
    messageError
  };
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

async function fetchPendingQuestions(client, directory, requestOptions = {}) {
  if (requestOptions?.signal?.aborted) {
    throw createAbortError("OpenCode question.list aborted");
  }
  if (typeof client?.question?.list !== "function") {
    return [];
  }
  const rows = await withTimeout(client.question.list({
    directory
  }, requestOptions), REQUEST_TIMEOUT_MS, `OpenCode question.list directory=${directory}`, requestOptions);
  return normalizeQuestionRows(rows);
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

export async function fetchPendingQuestionsWithRetry(client, directory, requestOptions = {}, options = {}) {
  const maxAttempts = Math.max(1, Number(options?.maxAttempts || 0) || SESSION_MESSAGES_RETRY_ATTEMPTS);
  const baseDelayMs = Math.max(100, Number(options?.retryDelayMs || 0) || SESSION_MESSAGES_RETRY_DELAY_MS);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (requestOptions?.signal?.aborted) {
      throw createAbortError(`OpenCode question.list directory=${directory} aborted`);
    }
    try {
      return await fetchPendingQuestions(client, directory, requestOptions);
    } catch (error) {
      if (attempt >= maxAttempts || !isRetriableSessionReadError(error)) {
        throw error;
      }
      const delayMs = retryDelayMs(baseDelayMs, attempt);
      console.warn(`[trace][session] question.list retry directory=${directory} attempt=${attempt}/${maxAttempts} delayMs=${delayMs} reason=${String(error?.message || error)}`);
      await sleep(delayMs);
    }
  }
  return [];
}

export async function waitForAssistantMessage(client, directory, sessionId, sinceCreatedAt = 0, seenMessageIds = new Set(), seenQuestionIds = new Set(), requestOptions = {}) {
  const startedAt = Date.now();
  const progressState = requestOptions?.progressState && typeof requestOptions.progressState === "object"
    ? requestOptions.progressState
    : null;
  const activityState = {
    lastObservedAt: startedAt,
    lastSnapshotKey: ""
  };
  let waitForeverLogged = false;
  const resolveDeadline = () => {
    const firstProgressAt = Number(progressState?.firstProgressAt || 0);
    if (WAIT_FOREVER_AFTER_PROGRESS && Number.isFinite(firstProgressAt) && firstProgressAt > 0 && !waitForeverLogged) {
      waitForeverLogged = true;
      console.log(
        `[trace][session] waitForAssistantMessage wait-forever enabled directory=${directory}`
        + ` session=${sessionId}`
      );
    }
    return computeAssistantWaitDeadline(startedAt, progressState, activityState);
  };
  let polls = 0;
  let transientFailures = 0;
  let latestSnapshot = null;
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
    let questionRows = [];
    try {
      questionRows = await fetchPendingQuestionsWithRetry(client, directory, requestOptions, { maxAttempts: 1 });
    } catch (error) {
      if (isAbortLikeError(error)) {
        throw error;
      }
      console.warn(`[trace][session] question.list transient-failure directory=${directory} session=${sessionId} reason=${String(error?.message || error)}`);
    }
    const snapshot = readLatestAssistantResponse(rows, questionRows, sessionId, sinceCreatedAt, seenMessageIds, seenQuestionIds);
    const snapshotKey = buildAssistantSnapshotKey(snapshot);
    if (snapshotKey !== activityState.lastSnapshotKey) {
      activityState.lastSnapshotKey = snapshotKey;
      activityState.lastObservedAt = Date.now();
    }
    latestSnapshot = snapshot;
    if (snapshot.completed) {
      if (progressState) {
        const now = Date.now();
        progressState.lastProgressAt = now;
        if (!progressState.firstProgressAt) {
          progressState.firstProgressAt = now;
        }
      }
      console.log(
        `[trace][session] waitForAssistantMessage hit directory=${directory} session=${sessionId}`
        + ` polls=${polls} elapsedMs=${Date.now() - startedAt} outputLen=${String(snapshot.text || "").length}`
        + ` messageCompleted=${snapshot.messageCompleted ? 1 : 0} messageTerminal=${snapshot.messageTerminal ? 1 : 0}`
        + ` hasQuestion=${snapshot.hasQuestion ? 1 : 0} finish=${snapshot.messageFinish || ""}`
      );
      return String(snapshot.text || "");
    }
    await sleep(MESSAGE_POLL_INTERVAL_MS);
  }
  const sinceProgressMs = Number(progressState?.lastProgressAt || 0) > 0
    ? Date.now() - Number(progressState.lastProgressAt)
    : -1;
  const sinceObservedMs = Number(activityState?.lastObservedAt || 0) > 0
    ? Date.now() - Number(activityState.lastObservedAt)
    : -1;
  throw new Error(
    `OpenCode 消息轮询超时（>${MESSAGE_POLL_TIMEOUT_MS}ms）`
    + `${sinceProgressMs >= 0 ? `，距最近进度 ${sinceProgressMs}ms` : ""}`
    + `${sinceObservedMs >= 0 ? `，距最近状态变化 ${sinceObservedMs}ms` : ""}`
  );
}

export function readLatestAssistantProgress(rows, sinceCreatedAt = 0, seenMessageIds = new Set()) {
  const latest = latestAssistantMessage(rows, sinceCreatedAt, seenMessageIds);
  return {
    messageId: String(latest?.id || ""),
    text: String(latest?.text || ""),
    completed: Boolean(latest?.completed)
  };
}
