import {
  abortSession,
  createSession,
  isAbortLikeError,
  listSessions,
  sendMessageToSession
} from "../opencode/client.js";
import { listAvailableModels } from "../opencode/model-catalog.js";

export function createOpenCodeRuntimeProvider() {
  return {
    id: "opencode",
    label: "OpenCode SDK",
    session: {
      list: async (directory) => await listSessions(directory),
      create: async (directory, title) => await createSession(directory, title),
      abort: async (directory, sessionId) => await abortSession(directory, sessionId)
    },
    model: {
      list: async (forceRefresh = false) => await listAvailableModels(forceRefresh)
    },
    run: {
      sendMessage: async (directory, sessionId, text, model, options = {}) => {
        return await sendMessageToSession(directory, sessionId, text, model, options);
      },
      isAbortLikeError
    }
  };
}
