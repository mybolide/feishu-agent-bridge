import path from "node:path";
import { getBinding, getThreadModel, getThreadTool, setThreadPath } from "../../state/store.js";
import { getDefaultRuntimeProviderId } from "../../agent-runtime/index.js";

export function createOcCommandHandler({
  sendText,
  showModelCard,
  showToolCard,
  getNavigationCwd,
  bindWorkspace
}) {
  return async function handleOcCommand(chatId, text) {
    const input = String(text || "").trim();
    if (!input.startsWith("/oc")) {
      return false;
    }

    const bindWithPathMatch = input.match(/^\/oc\s+bind\s+(.+?)(?:\s+([\w./-]+))?$/i);
    if (/^\/oc\s+bind\s*$/i.test(input)) {
      const cwd = getNavigationCwd(chatId);
      await bindWorkspace(chatId, cwd, "main");
      await sendText(chatId, `✅ 工作区已绑定\n\n路径：${cwd}\n分支：main`);
      return true;
    }

    if (bindWithPathMatch) {
      const repoPath = String(bindWithPathMatch[1] || "").trim();
      const branch = String(bindWithPathMatch[2] || "main").trim() || "main";
      if (!repoPath) {
        await sendText(chatId, "❌ 缺少路径：/oc bind <repoPath> [branch]");
        return true;
      }
      await bindWorkspace(chatId, repoPath, branch);
      setThreadPath(chatId, path.resolve(repoPath));
      await sendText(chatId, `✅ 工作区已绑定\n\n路径：${repoPath}\n分支：${branch}`);
      return true;
    }

    if (/^\/oc\s+(model|models)\b/i.test(input)) {
      await showModelCard(chatId);
      return true;
    }

    if (/^\/oc\s+(tool|tools)\b/i.test(input)) {
      if (typeof showToolCard === "function") {
        await showToolCard(chatId);
      } else {
        await sendText(chatId, "❌ 工具选择入口未就绪，请稍后重试");
      }
      return true;
    }

    if (/^\/oc\s+status\b/i.test(input)) {
      const binding = getBinding(chatId);
      const model = getThreadModel(chatId) || "未设置";
      const tool = getThreadTool(chatId) || getDefaultRuntimeProviderId();
      if (!binding) {
        await sendText(chatId, "❌ 未绑定工作区，请先 /oc bind <repoPath> [branch]");
        return true;
      }
      await sendText(chatId, `✅ 状态\n\n路径：${binding.repoPath}\n分支：${binding.branch}\n工具：${tool}\n模型：${model}`);
      return true;
    }

    if (/^\/oc\s+help\b/i.test(input)) {
      await sendText(chatId, "可用命令：\n- /oc bind <repoPath> [branch]\n- /oc tool\n- /oc model\n- /oc status");
      return true;
    }

    await sendText(chatId, "⚠️ 未识别命令。可用：/oc bind, /oc tool, /oc model, /oc status, /oc help");
    return true;
  };
}
