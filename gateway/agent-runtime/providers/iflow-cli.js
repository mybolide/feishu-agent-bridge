import { isAbortLikeError } from "../iflow/internal/common.js";
import { listModels } from "../iflow/internal/model-service.js";
import { sendMessageToSession } from "../iflow/internal/message-service.js";
import { abortSession, createSession, ensureCleanupTimer, listSessions } from "../iflow/internal/session-pool.js";

export { isAbortLikeError };

export function createIFlowRuntimeProvider() {
  ensureCleanupTimer();
  return {
    id: "iflow-cli",
    label: "iFlow CLI SDK",
    session: {
      list: async (directory) => await listSessions(directory),
      create: async (directory, title) => await createSession(directory, title),
      abort: async (directory, sessionId) => await abortSession(directory, sessionId)
    },
    model: {
      list: async (forceRefresh = false) => await listModels(forceRefresh)
    },
    run: {
      sendMessage: async (directory, sessionId, text, model, options = {}) => {
        return await sendMessageToSession(directory, sessionId, text, model, options);
      },
      isAbortLikeError
    }
  };
}
