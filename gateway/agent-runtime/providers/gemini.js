import {
  createGeminiSession,
  listGeminiSessions,
  sendGeminiMessage,
  abortGeminiSession,
  isAbortLikeError
} from "../gemini/client.js";

export function createGeminiRuntimeProvider() {
  return {
    id: "gemini-cli",
    label: "Gemini CLI",
    session: {
      list: async (directory) => await listGeminiSessions(directory),
      create: async (directory, title) => await createGeminiSession(directory, title),
      abort: async (directory, sessionId) => await abortGeminiSession(directory, sessionId)
    },
    model: {
      list: async (forceRefresh = false) => {
        // Gemini CLI 支持的模型
        return [
          { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "google" },
          { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", provider: "google" },
          { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash", provider: "google" },
          { id: "gemini-1.5-pro", name: "Gemini 1.5 Pro", provider: "google" },
          { id: "gemini-1.5-flash", name: "Gemini 1.5 Flash", provider: "google" }
        ];
      }
    },
    run: {
      sendMessage: async (directory, sessionId, text, model, options = {}) => {
        const result = await sendGeminiMessage(directory, sessionId, text, model, options);
        if (result.error && !result.output) {
          const err = new Error(result.error.message || "Unknown error");
          err.name = result.error.name || "UnknownError";
          throw err;
        }
        if (result.error && result.output) {
          return `${result.output}\n\n⚠️ ${result.error.name}: ${result.error.message}`;
        }
        return result.output;
      },
      isAbortLikeError
    }
  };
}