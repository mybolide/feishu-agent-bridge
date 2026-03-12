import { isAbortLikeError, parseModelId } from "./common.js";
import { getSessionWrapper, ensureConnected, rememberSession, resetSessionWrapper } from "./session-runtime.js";
import { receiveAssistantResponse, sendSessionMessage, setSessionModel } from "./message-runtime.js";

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
      throw new Error("iFlow sendMessage aborted before start");
    }
    signal.addEventListener("abort", abortHandler, { once: true });
  }

  try {
    await setSessionModel(wrapper, normalizedSessionId, selectedModel, options);
    await sendSessionMessage(wrapper, normalizedSessionId, text, options);
    const output = await receiveAssistantResponse(wrapper, normalizedSessionId, options);
    if (aborted || signal?.aborted) {
      throw new Error(`iFlow sendMessage aborted session=${normalizedSessionId}`);
    }
    rememberSession(normalizedSessionId, wrapper.directory, wrapper.title);
    return output;
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
