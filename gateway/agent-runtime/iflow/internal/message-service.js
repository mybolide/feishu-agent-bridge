import { MessageType } from "@iflow-ai/iflow-cli-sdk";
import {
  REQUEST_TIMEOUT_MS,
  buildAskUserAnswers,
  createAbortError,
  isAbortLikeError,
  parseModelId,
  withTimeout
} from "./common.js";
import { ensureConnected, getSessionWrapper, rememberSession, resetSessionWrapper } from "./session-pool.js";

const DEFAULT_FIRST_TOKEN_TIMEOUT_MS = 3 * 60 * 1000;
const DEFAULT_RECEIVE_IDLE_TIMEOUT_MS = 3 * 60 * 1000;

function parsePositiveInt(raw, fallback) {
  const value = Number.parseInt(String(raw || "").trim(), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const FIRST_TOKEN_TIMEOUT_MS = parsePositiveInt(
  process.env.IFLOW_FIRST_TOKEN_TIMEOUT_MS,
  DEFAULT_FIRST_TOKEN_TIMEOUT_MS
);
const RECEIVE_IDLE_TIMEOUT_MS = parsePositiveInt(
  process.env.IFLOW_RECEIVE_IDLE_TIMEOUT_MS,
  DEFAULT_RECEIVE_IDLE_TIMEOUT_MS
);

export async function sendMessageToSession(directory, sessionId, text, model, options = {}) {
  const normalizedSessionId = String(sessionId || "").trim();
  if (!normalizedSessionId) {
    throw new Error("iFlow sessionId is required");
  }
  const wrapper = getSessionWrapper(normalizedSessionId, directory);
  if (!wrapper) {
    throw new Error("iFlow session wrapper unavailable");
  }
  await ensureConnected(wrapper, options);
  if (wrapper.busy) {
    throw new Error(`iFlow session is busy: ${normalizedSessionId}`);
  }
  wrapper.busy = true;
  wrapper.lastUsedAt = Date.now();
  const signal = options?.signal;
  const onProgress = typeof options?.onProgress === "function" ? options.onProgress : null;
  const selectedModel = parseModelId(model);
  let aborted = false;
  const abortHandler = async () => {
    aborted = true;
    try {
      await wrapper.client.interrupt();
    } catch {
      // ignore interrupt errors
    }
  };
  if (signal) {
    if (signal.aborted) {
      await abortHandler();
      throw createAbortError("iFlow sendMessage aborted before start");
    }
    signal.addEventListener("abort", abortHandler, { once: true });
  }
  try {
    if (selectedModel) {
      try {
        await withTimeout(
          wrapper.client.config.set("model", selectedModel),
          REQUEST_TIMEOUT_MS,
          `iFlow set model session=${normalizedSessionId}`,
          options
        );
      } catch (error) {
        console.warn(`[trace][iflow] set model failed session=${normalizedSessionId} model=${selectedModel}`, error);
      }
    }
    await withTimeout(
      wrapper.client.sendMessage(String(text || "")),
      REQUEST_TIMEOUT_MS,
      `iFlow send message session=${normalizedSessionId}`,
      options
    );
    let output = "";
    const iterator = wrapper.client.receiveMessages();
    const receiveStartedAt = Date.now();
    let firstTokenAt = 0;
    while (true) {
      const receiveTimeoutMs = firstTokenAt > 0 ? RECEIVE_IDLE_TIMEOUT_MS : FIRST_TOKEN_TIMEOUT_MS;
      const next = await withTimeout(
        iterator.next(),
        receiveTimeoutMs,
        `iFlow receive message session=${normalizedSessionId} firstToken=${firstTokenAt > 0 ? 1 : 0}`,
        options
      );
      if (next.done) {
        break;
      }
      if (aborted || signal?.aborted) {
        throw createAbortError(`iFlow sendMessage aborted session=${normalizedSessionId}`);
      }
      const message = next.value && typeof next.value === "object" ? next.value : {};
      const messageType = String(message?.type || "").trim();
      if (messageType === MessageType.ASSISTANT) {
        const chunk = String(message?.chunk?.text || "");
        if (chunk) {
          if (!firstTokenAt) {
            firstTokenAt = Date.now();
            console.log(
              `[trace][iflow] first-token session=${normalizedSessionId} ttfbMs=${firstTokenAt - receiveStartedAt} chunkLen=${chunk.length}`
            );
          }
          output += chunk;
          if (onProgress) {
            await onProgress({
              messageId: normalizedSessionId,
              text: output,
              completed: false
            });
          }
        }
        continue;
      }
      if (messageType === MessageType.PERMISSION_REQUEST) {
        const requestId = message?.requestId;
        const optionId = String(message?.options?.[0]?.optionId || "").trim();
        if (requestId !== undefined && optionId) {
          await wrapper.client.respondToToolConfirmation(requestId, optionId).catch(() => undefined);
        }
        continue;
      }
      if (messageType === MessageType.EXIT_PLAN_MODE) {
        await wrapper.client.respondToExitPlanMode(true).catch(() => undefined);
        continue;
      }
      if (messageType === MessageType.ASK_USER_QUESTIONS) {
        const answers = buildAskUserAnswers(message?.questions);
        const keys = Object.keys(answers);
        if (keys.length === 0) {
          throw new Error("iFlow ask_user_questions 返回为空，无法自动应答");
        }
        await wrapper.client.respondToAskUserQuestions(answers);
        continue;
      }
      if (messageType === MessageType.ERROR) {
        throw new Error(String(message?.message || "iFlow returned error message"));
      }
      if (messageType === MessageType.TASK_FINISH) {
        break;
      }
    }
    console.log(
      `[trace][iflow] receive-finish session=${normalizedSessionId} elapsedMs=${Date.now() - receiveStartedAt} outputLen=${output.length}`
    );
    if (onProgress && output) {
      await onProgress({
        messageId: normalizedSessionId,
        text: output,
        completed: true
      });
    }
    rememberSession(normalizedSessionId, wrapper.directory, wrapper.title);
    return output.trim();
  } catch (error) {
    const message = String(error?.message || error || "").trim();
    const shouldReset = message.includes("iFlow receive message")
      || message.includes("iFlow send message")
      || message.includes("timeout");
    if (shouldReset && !isAbortLikeError(error)) {
      try {
        await resetSessionWrapper(normalizedSessionId, message.slice(0, 160));
      } catch {
        // ignore reset errors
      }
    }
    throw error;
  } finally {
    wrapper.busy = false;
    wrapper.lastUsedAt = Date.now();
    if (signal) {
      signal.removeEventListener("abort", abortHandler);
    }
  }
}
