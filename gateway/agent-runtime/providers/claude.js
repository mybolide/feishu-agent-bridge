import {
  createClaudeSession,
  listClaudeSessions,
  sendClaudeMessage,
  abortClaudeSession,
  isAbortLikeError
} from "../claude/client.js";

export function createClaudeRuntimeProvider() {
  return {
    id: "claude",
    label: "Claude Code SDK",
    session: {
      list: async (directory) => await listClaudeSessions(directory),
      create: async (directory, title) => await createClaudeSession(directory, title),
      abort: async (directory, sessionId) => await abortClaudeSession(directory, sessionId)
    },
    model: {
      list: async (forceRefresh = false) => {
        // 百炼 Coding Plan 支持的模型
        return [
          { id: "qwen3.5-plus", name: "Qwen3.5 Plus", provider: "bailian" },
          { id: "glm-5", name: "GLM-5", provider: "bailian" },
          { id: "kimi-k2.5", name: "Kimi K2.5", provider: "bailian" },
          { id: "MiniMax-M2.5", name: "MiniMax M2.5", provider: "bailian" }
        ];
      }
    },
    run: {
      sendMessage: async (directory, sessionId, text, model, options = {}) => {
        const result = await sendClaudeMessage(directory, sessionId, text, model, options);
        
        // 返回对象，包含 output 和 sessionId（用于更新会话）
        const outputText = result.error && result.output
          ? `${result.output}\n\n⚠️ ${result.error.name}: ${result.error.message}`
          : result.output || "";
        
        if (result.error && !result.output) {
          const err = new Error(result.error.message || "Unknown error");
          err.name = result.error.name || "UnknownError";
          throw err;
        }
        
        return {
          output: outputText,
          sessionId: result.sessionId,  // 返回新的 sessionId
          error: result.error
        };
      },
      isAbortLikeError
    }
  };
}