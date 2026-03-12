import {
  REQUEST_TIMEOUT_MS,
  SESSION_LIST_RETRY_ATTEMPTS,
  SESSION_LIST_RETRY_DELAY_MS,
  SESSION_LIST_TIMEOUT_MS,
  createSdkClient,
  extractSessionDirectory,
  isAbortLikeError,
  isRetriableSessionReadError,
  normalizeDirectory,
  retryDelayMs,
  sleep,
  withTimeout
} from "./client-core.js";
import {
  extractMessageCreatedAt,
  extractMessageId,
  extractTextFromParts,
  fetchSessionMessagesWithRetry,
  messageRole,
  normalizeModelPayload,
  toSessionRows,
  waitForAssistantMessage
} from "./message-reader.js";
import { startAssistantProgressPump } from "./progress-pump.js";

export { isAbortLikeError } from "./client-core.js";

export async function listSessions(directory) {
  const normalizedDir = normalizeDirectory(directory);
  const startedAt = Date.now();
  console.log(`[trace][session] listSessions start directory=${normalizedDir}`);
  const client = createSdkClient(normalizedDir);
  let rows = [];
  for (let attempt = 1; attempt <= SESSION_LIST_RETRY_ATTEMPTS; attempt += 1) {
    try {
      rows = await withTimeout(client.session.list({
        directory: normalizedDir,
        limit: 100
      }), SESSION_LIST_TIMEOUT_MS, `OpenCode session.list directory=${normalizedDir}`);
      break;
    } catch (error) {
      if (attempt >= SESSION_LIST_RETRY_ATTEMPTS || !isRetriableSessionReadError(error)) {
        throw error;
      }
      const delayMs = retryDelayMs(SESSION_LIST_RETRY_DELAY_MS, attempt);
      console.warn(`[trace][session] listSessions retry directory=${normalizedDir} attempt=${attempt}/${SESSION_LIST_RETRY_ATTEMPTS} delayMs=${delayMs} reason=${String(error?.message || error)}`);
      await sleep(delayMs);
    }
  }
  const normalizedRows = toSessionRows(rows);
  console.log(`[trace][session] listSessions sdk-hit directory=${normalizedDir} count=${normalizedRows.length} elapsedMs=${Date.now() - startedAt}`);
  return normalizedRows;
}

export async function createSession(directory, title) {
  const normalizedDir = normalizeDirectory(directory);
  const startedAt = Date.now();
  console.log(`[trace][session] createSession request directory=${normalizedDir} title=${JSON.stringify(String(title || ""))}`);
  const client = createSdkClient(normalizedDir);
  const created = await withTimeout(client.session.create({
    directory: normalizedDir,
    title
  }), REQUEST_TIMEOUT_MS, `OpenCode session.create directory=${normalizedDir}`);
  const id = String(created?.id || "").trim();
  if (!id) {
    throw new Error("OpenCode create session returned no session id");
  }
  console.log(`[trace][session] createSession created directory=${normalizedDir} session=${id} title=${JSON.stringify(String(created?.title || title || ""))} elapsedMs=${Date.now() - startedAt}`);
  return {
    id,
    title: String(created?.title || title || ""),
    directory: extractSessionDirectory(created) || normalizedDir
  };
}

export async function sendMessageToSession(directory, sessionId, text, model, options = {}) {
  const normalizedDir = normalizeDirectory(directory);
  console.log(`[trace][session] sendMessageToSession start directory=${normalizedDir} session=${sessionId} model=${model || ""} text=${JSON.stringify(String(text || "").slice(0, 120))}`);
  const client = createSdkClient(normalizedDir);
  const baselineStartedAt = Date.now();
  const requestOptions = options?.signal ? { signal: options.signal } : {};
  const baselineRows = await fetchSessionMessagesWithRetry(client, normalizedDir, sessionId, requestOptions);
  console.log(`[trace][session] sendMessageToSession baseline-loaded directory=${normalizedDir} session=${sessionId} rows=${baselineRows.length} elapsedMs=${Date.now() - baselineStartedAt}`);
  const seenAssistantIds = new Set(baselineRows
    .filter((item) => messageRole(item) === "assistant")
    .map((item) => extractMessageId(item))
    .filter(Boolean));
  const sinceCreatedAt = baselineRows.reduce((max, item) => Math.max(max, extractMessageCreatedAt(item)), 0);
  const onProgress = typeof options?.onProgress === "function" ? options.onProgress : null;
  let promptStartedAt = 0;
  let firstProgressAt = 0;
  let progressEvents = 0;
  const progressState = { lastProgressAt: 0, firstProgressAt: 0 };
  const emitProgress = async (progress) => {
    const payload = progress && typeof progress === "object" ? progress : {};
    const content = String(payload?.text || "");
    if (content) {
      progressEvents += 1;
      const now = Date.now();
      progressState.lastProgressAt = now;
      if (!progressState.firstProgressAt) {
        progressState.firstProgressAt = now;
      }
      if (!firstProgressAt && promptStartedAt > 0) {
        firstProgressAt = Date.now();
        console.log(`[trace][session] sendMessageToSession first-progress directory=${normalizedDir} session=${sessionId} ttfbMs=${firstProgressAt - promptStartedAt} textLen=${content.length}`);
      }
    }
    if (onProgress) {
      await onProgress(payload);
    }
  };
  let lastProgressText = "";
  let lastProgressCompleted = false;
  const progressCallback = onProgress
    ? async (progress) => {
      const payload = progress && typeof progress === "object" ? progress : {};
      const nextText = String(payload?.text || "").trim();
      if (!nextText) {
        return;
      }
      const completed = Boolean(payload?.completed);
      if (nextText === lastProgressText && completed === lastProgressCompleted) {
        return;
      }
      lastProgressText = nextText;
      lastProgressCompleted = completed;
      await emitProgress({ ...payload, text: nextText, completed });
    }
    : null;
  const payload = {
    sessionID: sessionId,
    directory: normalizedDir,
    parts: [{ type: "text", text }]
  };
  const modelPayload = normalizeModelPayload(model);
  if (modelPayload) {
    payload.model = modelPayload;
  }
  const stopProgressPolling = startAssistantProgressPump(
    client,
    normalizedDir,
    sessionId,
    sinceCreatedAt,
    seenAssistantIds,
    progressCallback,
    requestOptions
  );
  promptStartedAt = Date.now();
  try {
    let syncOutput = "";
    if (typeof client?.session?.promptAsync === "function") {
      await withTimeout(client.session.promptAsync(payload, requestOptions), REQUEST_TIMEOUT_MS, `OpenCode session.prompt_async session=${sessionId}`, requestOptions);
      console.log(`[trace][session] sendMessageToSession prompt-accepted directory=${normalizedDir} session=${sessionId} elapsedMs=${Date.now() - promptStartedAt}`);
    } else {
      const result = await withTimeout(client.session.prompt(payload, requestOptions), REQUEST_TIMEOUT_MS, `OpenCode session.prompt session=${sessionId}`, requestOptions);
      syncOutput = extractTextFromParts(result?.parts);
      console.log(`[trace][session] sendMessageToSession prompt-finished directory=${normalizedDir} session=${sessionId} outputLen=${syncOutput.length} elapsedMs=${Date.now() - promptStartedAt}`);
    }
    if (syncOutput) {
      if (progressCallback) {
        await progressCallback({ messageId: "", text: syncOutput, completed: true });
      }
      return syncOutput;
    }
    console.log(`[trace][session] sendMessageToSession wait-poll directory=${normalizedDir} session=${sessionId} sinceCreatedAt=${sinceCreatedAt}`);
    const waitedOutput = await waitForAssistantMessage(
      client,
      normalizedDir,
      sessionId,
      sinceCreatedAt,
      seenAssistantIds,
      { ...requestOptions, progressState }
    );
    if (progressCallback && waitedOutput) {
      await progressCallback({ messageId: "", text: waitedOutput, completed: true });
    }
    return waitedOutput;
  } finally {
    const ttfbMs = firstProgressAt && promptStartedAt ? (firstProgressAt - promptStartedAt) : -1;
    if (promptStartedAt > 0) {
      console.log(`[trace][session] sendMessageToSession progress-summary directory=${normalizedDir} session=${sessionId} ttfbMs=${ttfbMs} progressEvents=${progressEvents}`);
    }
    await stopProgressPolling();
  }
}

export async function abortSession(directory, sessionId) {
  const normalizedDir = normalizeDirectory(directory);
  const client = createSdkClient(normalizedDir);
  await withTimeout(client.session.abort({
    sessionID: sessionId,
    directory: normalizedDir
  }), REQUEST_TIMEOUT_MS, `OpenCode session.abort session=${sessionId}`);
}
