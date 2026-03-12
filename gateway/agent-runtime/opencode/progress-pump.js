import {
  EVENT_STREAM_RETRY_DELAY_MS,
  isAbortLikeError,
  sleep,
  STREAM_PROGRESS_INTERVAL_MS
} from "./client-core.js";
import {
  fetchSessionMessagesWithRetry,
  normalizeEventPayload,
  readLatestAssistantProgress
} from "./message-reader.js";

function startAssistantProgressPolling(client, directory, sessionId, sinceCreatedAt, seenMessageIds, onProgress, requestOptions = {}) {
  if (typeof onProgress !== "function") {
    return async () => undefined;
  }
  let stopped = false;
  let inflight = Promise.resolve();
  let lastProgressKey = "";
  const poll = async () => {
    while (!stopped) {
      if (requestOptions?.signal?.aborted) {
        return;
      }
      try {
        const rows = await fetchSessionMessagesWithRetry(client, directory, sessionId, requestOptions, { maxAttempts: 1 });
        const latest = readLatestAssistantProgress(rows, sinceCreatedAt, seenMessageIds);
        const text = String(latest?.text || "");
        const nextKey = `${String(latest?.messageId || "")}:${text.length}:${latest?.completed ? 1 : 0}`;
        if (text && nextKey !== lastProgressKey) {
          lastProgressKey = nextKey;
          await onProgress(latest);
        }
      } catch (error) {
        if (isAbortLikeError(error)) {
          return;
        }
        console.warn(`[trace][session] progress polling failed session=${sessionId}`, error);
      }
      await sleep(STREAM_PROGRESS_INTERVAL_MS);
    }
  };
  inflight = poll();
  return async () => {
    stopped = true;
    await inflight.catch(() => undefined);
  };
}

function startAssistantProgressEventStreaming(client, directory, sessionId, sinceCreatedAt, seenMessageIds, onProgress, requestOptions = {}) {
  if (typeof onProgress !== "function") {
    return async () => undefined;
  }
  let stopped = false;
  const streamAbortController = new AbortController();
  const upstreamSignal = requestOptions?.signal;
  let upstreamAbortHandler = null;
  if (upstreamSignal) {
    if (upstreamSignal.aborted) {
      streamAbortController.abort();
    } else {
      upstreamAbortHandler = () => streamAbortController.abort();
      upstreamSignal.addEventListener("abort", upstreamAbortHandler, { once: true });
    }
  }
  const streamRequestOptions = { ...requestOptions, signal: streamAbortController.signal };
  const assistantStates = new Map();
  let inflight = Promise.resolve();
  const upsertAssistantState = (messageID, createdAt = 0) => {
    const key = String(messageID || "").trim();
    if (!key || seenMessageIds.has(key)) {
      return null;
    }
    const nextCreatedAt = Number(createdAt || 0);
    if (nextCreatedAt > 0 && nextCreatedAt < sinceCreatedAt) {
      return null;
    }
    const existed = assistantStates.get(key);
    if (existed) {
      if (nextCreatedAt > 0 && (!existed.createdAt || nextCreatedAt < existed.createdAt)) {
        existed.createdAt = nextCreatedAt;
      }
      return existed;
    }
    const created = {
      messageID: key,
      createdAt: nextCreatedAt,
      completed: false,
      partOrder: [],
      partTexts: new Map()
    };
    assistantStates.set(key, created);
    return created;
  };
  const mergePartText = (state, partID, text, append = false) => {
    if (!state || !partID) {
      return;
    }
    const key = String(partID || "").trim();
    if (!key) {
      return;
    }
    const incoming = String(text || "");
    const prev = String(state.partTexts.get(key) || "");
    state.partTexts.set(key, append ? `${prev}${incoming}` : incoming);
    if (!state.partOrder.includes(key)) {
      state.partOrder.push(key);
    }
  };
  const composeStateText = (state) => state.partOrder.map((id) => String(state.partTexts.get(id) || "")).join("");
  const emitStateProgress = async (state, completed = false) => {
    if (!state) {
      return;
    }
    const text = composeStateText(state);
    if (!text) {
      return;
    }
    await onProgress({
      messageId: state.messageID,
      text,
      completed: Boolean(completed || state.completed)
    });
  };
  const onEvent = async (rawEvent) => {
    const event = normalizeEventPayload(rawEvent);
    const type = String(event?.type || "").trim();
    if (!type) {
      return;
    }
    const properties = event?.properties && typeof event.properties === "object"
      ? event.properties
      : {};
    if (type === "message.updated") {
      const info = properties.info && typeof properties.info === "object" ? properties.info : {};
      if (String(info.sessionID || "").trim() !== sessionId) {
        return;
      }
      if (String(info.role || "").trim().toLowerCase() !== "assistant") {
        return;
      }
      const createdAt = Number(info?.time?.created || 0);
      const state = upsertAssistantState(info.id, createdAt);
      if (!state) {
        return;
      }
      const completedAt = Number(info?.time?.completed || 0);
      if (completedAt > 0 && !state.completed) {
        state.completed = true;
        await emitStateProgress(state, true);
      }
      return;
    }
    if (type === "message.part.delta") {
      if (String(properties.sessionID || "").trim() !== sessionId) {
        return;
      }
      if (String(properties.field || "").trim() !== "text") {
        return;
      }
      const state = assistantStates.get(String(properties.messageID || "").trim());
      if (!state) {
        return;
      }
      mergePartText(state, properties.partID, properties.delta, true);
      await emitStateProgress(state, false);
      return;
    }
    if (type === "message.part.updated") {
      const part = properties.part && typeof properties.part === "object" ? properties.part : {};
      if (String(part.sessionID || "").trim() !== sessionId) {
        return;
      }
      const state = assistantStates.get(String(part.messageID || "").trim());
      if (!state) {
        return;
      }
      const partType = String(part.type || "").trim();
      if (partType === "text") {
        mergePartText(state, part.id, part.text, false);
        await emitStateProgress(state, false);
        return;
      }
      if (partType === "step-finish") {
        state.completed = true;
        await emitStateProgress(state, true);
      }
    }
  };
  const streamLoop = async () => {
    while (!stopped) {
      if (streamRequestOptions?.signal?.aborted) {
        return;
      }
      try {
        const streamResult = await client.event.subscribe({ directory }, streamRequestOptions);
        for await (const item of streamResult?.stream || []) {
          if (stopped || streamRequestOptions?.signal?.aborted) {
            return;
          }
          await onEvent(item);
        }
      } catch (error) {
        if (isAbortLikeError(error)) {
          return;
        }
        console.warn(`[trace][session] progress event stream failed session=${sessionId}`, error);
      }
      await sleep(EVENT_STREAM_RETRY_DELAY_MS);
    }
  };
  inflight = streamLoop();
  return async () => {
    stopped = true;
    streamAbortController.abort();
    await inflight.catch(() => undefined);
    if (upstreamSignal && upstreamAbortHandler) {
      upstreamSignal.removeEventListener("abort", upstreamAbortHandler);
    }
  };
}

export function startAssistantProgressPump(client, directory, sessionId, sinceCreatedAt, seenMessageIds, onProgress, requestOptions = {}) {
  if (typeof onProgress !== "function") {
    return async () => undefined;
  }
  let lastProgressText = "";
  let lastProgressCompleted = false;
  const emitDedupedProgress = async (payload) => {
    const progress = payload && typeof payload === "object" ? payload : {};
    const text = String(progress?.text || "");
    const normalizedText = text.trim();
    if (!normalizedText) {
      return;
    }
    const messageId = String(progress?.messageId || "").trim();
    const completed = Boolean(progress?.completed);
    if (normalizedText === lastProgressText && completed === lastProgressCompleted) {
      return;
    }
    lastProgressText = normalizedText;
    lastProgressCompleted = completed;
    await onProgress({
      messageId,
      text: normalizedText,
      completed
    });
  };
  const stopEventStream = startAssistantProgressEventStreaming(
    client,
    directory,
    sessionId,
    sinceCreatedAt,
    seenMessageIds,
    emitDedupedProgress,
    requestOptions
  );
  const stopPolling = startAssistantProgressPolling(
    client,
    directory,
    sessionId,
    sinceCreatedAt,
    seenMessageIds,
    emitDedupedProgress,
    requestOptions
  );
  return async () => {
    await Promise.allSettled([stopEventStream(), stopPolling()]);
  };
}
