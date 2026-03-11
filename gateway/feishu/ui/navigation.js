import fs from "node:fs";
import path from "node:path";
import { projectRoot } from "../../config/index.js";
import {
  clearThreadModel,
  clearBinding,
  getBinding,
  getThreadModel,
  getThreadPath,
  getThreadTool,
  getThreadSession,
  latestQueuedRunForThread,
  patchQueuedRun,
  queuedRunSnapshot,
  setThreadModel,
  setThreadPath,
  setThreadSession,
  switchThreadTool
} from "../../state/store.js";
import { normalizeModelList, resolveRequestedModel } from "../../agent-runtime/model-routing.js";
import {
  getAgentRuntimeProvider,
  getDefaultRuntimeProviderId,
  isRuntimeProviderAvailable,
  listRuntimeProviders,
  resolveRuntimeProvider
} from "../../agent-runtime/index.js";

const navRoot = projectRoot;
const NAV_DIR_BUTTON_LIMIT = 12;
const NAV_FILE_BUTTON_LIMIT = 9;
const NAV_BUTTONS_PER_ROW = 3;
const NAV_ENTRY_BUTTONS_PER_ROW = 0;
const NAV_FLOW_ACTION_GROUP_LIMIT = 5;
const NAV_TOKEN_TTL_MS = 10 * 60 * 1000;
const NAV_TOKEN_STORE = new Map();

function listDriveRoots() {
  const roots = [];
  for (let idx = 65; idx <= 90; idx += 1) {
    const root = `${String.fromCharCode(idx)}:\\`;
    if (fs.existsSync(root)) {
      roots.push(root);
    }
  }
  return roots;
}

function isDriveAbsolute(text) {
  return text.length >= 3
    && /[A-Za-z]/.test(text[0])
    && text[1] === ":"
    && (text[2] === "\\" || text[2] === "/");
}

function resolveCdTarget(current, rawTarget) {
  const text = String(rawTarget || "").trim();
  if (!text) {
    return current;
  }
  if ((text.length === 1 || text.length === 2)
    && /[A-Za-z]/.test(text[0])
    && (text.length === 1 || text[1] === ":")) {
    return `${text[0].toUpperCase()}:\\`;
  }
  if (isDriveAbsolute(text)) {
    return path.normalize(text);
  }
  return path.resolve(current, text);
}

function isListDirectoryCommand(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    return false;
  }
  const lower = raw.toLowerCase();
  if (lower === "ls" || lower === "dir") {
    return true;
  }
  const compact = raw.replace(/\s+/g, "").replace(/[`'"，。！？,.!?:：；;]/g, "");
  return new Set([
    "查看当前目录",
    "看看当前目录",
    "列出当前目录",
    "显示当前目录",
    "现在目录在哪",
    "目录在哪",
    "当前目录在哪",
    "现在在哪个目录",
    "查看目录",
    "看看目录",
    "列出目录",
    "显示目录",
    "当前目录",
    "当前文件夹"
  ]).has(compact);
}

function listEntries(targetPath) {
  const dirs = [];
  const files = [];
  const hiddenDirs = new Set([".oc_trash", ".git"]);
  for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
    const name = String(entry.name || "");
    if (hiddenDirs.has(name)) {
      continue;
    }
    if (entry.isDirectory()) {
      dirs.push(name);
    } else if (entry.isFile()) {
      files.push(name);
    }
  }
  dirs.sort((a, b) => a.localeCompare(b, "zh-CN"));
  files.sort((a, b) => a.localeCompare(b, "zh-CN"));
  return { dirs, files };
}

function cleanupNavTokens() {
  const now = Date.now();
  for (const [token, item] of NAV_TOKEN_STORE.entries()) {
    if ((item?.expiresAt || 0) <= now) {
      NAV_TOKEN_STORE.delete(token);
    }
  }
}

function createNavToken(threadId, target) {
  cleanupNavTokens();
  const token = `nav_${Math.random().toString(36).slice(2, 10)}`;
  NAV_TOKEN_STORE.set(token, { threadId, target, expiresAt: Date.now() + NAV_TOKEN_TTL_MS });
  return token;
}

function resolveNavToken(threadId, token) {
  cleanupNavTokens();
  const item = NAV_TOKEN_STORE.get(String(token || ""));
  if (!item || item.threadId !== threadId) {
    return "";
  }
  return String(item.target || "");
}

function shortLabel(text, maxLen = 18) {
  const value = String(text || "");
  return value.length <= maxLen ? value : `${value.slice(0, maxLen - 1)}…`;
}

function buildActionRows(buttons, { layout = "trisection", buttonsPerRow = NAV_BUTTONS_PER_ROW } = {}) {
  const rows = [];
  let rowSize = Number(buttonsPerRow || 0);
  if (String(layout || "").trim().toLowerCase() === "flow") {
    rowSize = rowSize > 0 ? rowSize : NAV_FLOW_ACTION_GROUP_LIMIT;
  } else {
    rowSize = Math.max(rowSize || NAV_BUTTONS_PER_ROW, 1);
  }
  for (let i = 0; i < buttons.length; i += rowSize) {
    const chunk = buttons.slice(i, i + rowSize);
    rows.push({
      tag: "action",
      ...(layout ? { layout } : {}),
      actions: chunk.map((item) => ({
        tag: "button",
        type: item.type || "default",
        text: { tag: "plain_text", content: item.label },
        value: item.value || { action: "noop" }
      }))
    });
  }
  return rows;
}

function buildNavCard({ title = "", summary = "", controls = [], folderButtons = [], fileButtons = [] }) {
  const elements = [];
  if (summary) {
    elements.push({ tag: "div", text: { tag: "lark_md", content: summary } });
  }
  if (controls.length > 0) {
    elements.push({ tag: "hr" });
    elements.push({ tag: "markdown", content: "**操作按钮**" });
    elements.push(...buildActionRows(controls, { layout: "flow", buttonsPerRow: 0 }));
  }
  if (folderButtons.length > 0) {
    elements.push({ tag: "hr" });
    elements.push({ tag: "markdown", content: "**文件夹**" });
    elements.push(...buildActionRows(folderButtons, { layout: "flow", buttonsPerRow: NAV_ENTRY_BUTTONS_PER_ROW }));
  }
  if (fileButtons.length > 0) {
    elements.push({ tag: "hr" });
    elements.push({ tag: "markdown", content: "**文件**" });
    elements.push(...buildActionRows(fileButtons, { layout: "flow", buttonsPerRow: NAV_ENTRY_BUTTONS_PER_ROW }));
  }
  return {
    config: { wide_screen_mode: true },
    header: title ? { title: { tag: "plain_text", content: title } } : undefined,
    elements
  };
}

function mergeTaskFeedbackControls(taskFeedback = {}) {
  const runId = String(taskFeedback?.run_id || "").trim();
  const route = String(taskFeedback?.route || "").trim().toLowerCase();
  if (!runId || !route) {
    return [];
  }
  return [];
}

function resolveNavPath(current, raw) {
  const value = String(raw || "").trim();
  const absolute = path.isAbsolute(value) ? path.resolve(value) : path.resolve(current, value);
  if (!fs.existsSync(absolute)) {
    return { ok: false, message: `路径不存在：${absolute}` };
  }
  const stat = fs.statSync(absolute);
  return { ok: true, path: absolute, isDirectory: stat.isDirectory() };
}

function getThreadRuntimeProvider(threadId) {
  const selected = getThreadTool(threadId) || getDefaultRuntimeProviderId();
  return getAgentRuntimeProvider(selected);
}

async function abortRunWithSdk(run, requestRunAbort) {
  const runId = String(run?.runId || "").trim();
  const directory = String(run?.directory || "").trim();
  const sessionId = String(run?.sessionId || "").trim();
  const runtimeId = String(run?.runtimeId || run?.toolId || "").trim();
  if (!runId) {
    throw new Error("runId is required");
  }

  patchQueuedRun(runId, { status: "aborted" });
  if (typeof requestRunAbort === "function") {
    requestRunAbort(runId, "abort requested from feishu action");
  }
  if (!directory || !sessionId) {
    return { success: true, warning: "run 缺少目录或会话ID，已标记本地中止" };
  }

  try {
    const runtimeProvider = resolveRuntimeProvider(runtimeId) || getAgentRuntimeProvider();
    if (!runtimeProvider?.session || typeof runtimeProvider.session.abort !== "function") {
      return { success: true, warning: `工具 ${runtimeProvider.id} 不支持中止会话` };
    }
    await runtimeProvider.session.abort(directory, sessionId);
    return { success: true, warning: "" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: true, warning: message };
  }
}

export function createNavigationHandlers({
  sendText,
  sendCard,
  sendFileFromFile,
  showModelCard,
  showToolCard,
  bindWorkspace,
  requestRunAbort
}) {
  function getNavigationCwd(chatId) {
    const key = String(chatId || "").trim();
    const cached = getThreadPath(chatId);
    if (cached) {
      const resolvedCached = path.resolve(cached);
      try {
        if (fs.existsSync(resolvedCached) && fs.statSync(resolvedCached).isDirectory()) {
          console.log(`[trace][nav] cwd thread=${key} source=cached path=${resolvedCached}`);
          return resolvedCached;
        }
        console.log(`[trace][nav] cwd thread=${key} source=cached-invalid path=${resolvedCached}`);
      } catch {
        // ignore invalid cached path and fallback to binding/root
        console.log(`[trace][nav] cwd thread=${key} source=cached-error path=${resolvedCached}`);
      }
    }

    const binding = getBinding(chatId);
    if (binding?.repoPath) {
      const resolvedBinding = path.resolve(binding.repoPath);
      console.log(`[trace][nav] cwd thread=${key} source=binding path=${resolvedBinding}`);
      return resolvedBinding;
    }
    console.log(`[trace][nav] cwd thread=${key} source=root path=${navRoot}`);
    return navRoot;
  }

  async function sendDriveRootsCard(chatId) {
    const roots = listDriveRoots();
    if (roots.length === 0) {
      await sendText(chatId, "❌ 未检测到可用盘符");
      return;
    }
    const controls = roots.slice(0, NAV_DIR_BUTTON_LIMIT).map((root) => ({
      label: shortLabel(root, 6),
      type: "primary",
      value: { action: "nav_cd", token: createNavToken(chatId, root) }
    }));
    await sendCard(chatId, buildNavCard({ title: "可用根目录", summary: "点击盘符进入目录。", controls }));
  }

  async function sendSessionSelectCard(chatId, cwd) {
    const runtimeProvider = getThreadRuntimeProvider(chatId);
    if (!runtimeProvider?.session || typeof runtimeProvider.session.list !== "function") {
      await sendText(chatId, `❌ 工具 ${runtimeProvider.id} 不支持会话列表。`);
      return;
    }
    const sessions = (await runtimeProvider.session.list(cwd)).slice(0, 12);
    if (sessions.length === 0) {
      await sendText(chatId, `ℹ️ ${runtimeProvider.label} 暂无可选会话。你可以先点“新建会话”。`);
      return;
    }
    const active = getThreadSession(chatId);
    const folderButtons = sessions.map((item) => ({
      label: shortLabel(`${item.id === active ? "✅ " : ""}${item.title || item.id}`, 18),
      type: item.id === active ? "primary" : "default",
      value: { action: "nav_session_pick", sid: item.id }
    }));
    await sendCard(chatId, buildNavCard({
      summary: `**选择会话**\n\n当前激活：\`${active || "未绑定"}\`\n点击下方按钮可切换。`,
      controls: [
        { label: "返回目录", type: "default", value: { action: "nav_ls" } },
        { label: "新建会话", type: "primary", value: { action: "nav_new_session" } }
      ],
      folderButtons
    }));
  }

  async function showFileInfo(chatId, filePath) {
    const stat = fs.statSync(filePath);
    const fileToken = createNavToken(chatId, filePath);
    const cwdToken = createNavToken(chatId, path.dirname(filePath));
    const binding = getBinding(chatId);
    const summary = [
      "**📄 文件信息**",
      "",
      `- 名称：\`${path.basename(filePath)}\``,
      `- 路径：\`${filePath}\``,
      `- 大小：\`${stat.size} B\``,
      `- 修改时间：\`${new Date(stat.mtimeMs).toISOString()}\``
    ].join("\n");
    const controls = [
      { label: "发给我", type: "primary", value: { action: "nav_file_send", token: fileToken } },
      binding
        ? { label: "删除", type: "danger", value: { action: "nav_file_delete_confirm", token: fileToken } }
        : { label: "删除", type: "default", value: { action: "nav_file_delete_bind_required" } },
      { label: "返回目录", type: "default", value: { action: "nav_cd", token: cwdToken } }
    ];
    await sendCard(chatId, buildNavCard({ summary, controls }));
  }

  async function sendDirectoryCard(
    chatId,
    cwd,
    {
      showFolders = true,
      showFiles = true,
      taskOutput = null,
      taskFeedback = null,
      expandedControls = false,
      controlsOnly = false
    } = {}
  ) {
    const resolved = path.resolve(cwd);
    setThreadPath(chatId, resolved);
    const { dirs, files } = listEntries(resolved);
    const binding = getBinding(chatId);
    const workspacePath = String(binding?.repoPath || "").trim();
    const isOutsideWorkspace = Boolean(
      workspacePath && path.normalize(workspacePath) !== path.normalize(resolved)
    );
    console.log(`[trace][nav] render thread=${chatId} cwd=${resolved} workspace=${workspacePath || "(none)"} outside=${isOutsideWorkspace} showFolders=${showFolders} showFiles=${showFiles} expanded=${expandedControls}`);
    const activeSession = getThreadSession(chatId);
    const activeTool = getThreadTool(chatId) || getDefaultRuntimeProviderId();
    const activeModel = getThreadModel(chatId);
    const parent = path.resolve(resolved, "..");

    const folderButtons = [];
    if (path.normalize(parent) !== path.normalize(resolved)) {
      folderButtons.push({ label: "⬆️ 上一级", type: "default", value: { action: "nav_up" } });
    }
    if (showFolders) {
      folderButtons.push(...dirs.slice(0, NAV_DIR_BUTTON_LIMIT).map((name) => ({
        label: `📁 ${name}`,
        type: "primary",
        value: { action: "nav_cd", token: createNavToken(chatId, path.join(resolved, name)) }
      })));
    }
    const fileButtons = showFiles
      ? files.slice(0, NAV_FILE_BUTTON_LIMIT).map((name) => ({
        label: `📄 ${name}`,
        type: "default",
        value: { action: "nav_file", token: createNavToken(chatId, path.join(resolved, name)) }
      }))
      : [];

    const allControls = [
      { label: "根目录", type: "default", value: { action: "nav_roots" } },
      { label: "刷新", type: "default", value: { action: "nav_ls" } },
      { label: "新建文件夹", type: "primary", value: { action: "nav_mkdir_help" } }
    ];
    const feedbackControls = mergeTaskFeedbackControls(taskFeedback);
    if (binding) {
      allControls.push({ label: "会话选择", type: "default", value: { action: "nav_sessions" } });
      allControls.push({ label: "新建会话", type: "primary", value: { action: "nav_new_session" } });
      allControls.push({ label: "切换工具", type: "default", value: { action: "nav_tool_select" } });
      allControls.push({ label: "切换模型", type: "default", value: { action: "nav_model_select" } });
    }
    if (!showFolders && dirs.length > 0) {
      allControls.push({ label: "查看文件夹", type: "default", value: { action: "nav_show_folders" } });
    }
    if (!showFiles && files.length > 0) {
      allControls.push({ label: "查看文件", type: "default", value: { action: "nav_show_files" } });
    }
    if ((!showFolders || !showFiles) && (dirs.length > 0 || files.length > 0)) {
      allControls.push({ label: "显示文件+文件夹", type: "default", value: { action: "nav_show_all" } });
    }

    const controls = [];
    const quickControls = [];
    if (binding?.repoPath && isOutsideWorkspace) {
      quickControls.push({
        label: "🏠 返回工作空间",
        type: "primary",
        value: { action: "nav_workspace_home" }
      });
    }
    quickControls.push(binding
      ? { label: "解绑工作空间", type: "danger", value: { action: "nav_unbind" } }
      : { label: "绑定工作空间", type: "primary", value: { action: "nav_bind" } });
    if (expandedControls) {
      controls.push({ label: "返回目录", type: "default", value: { action: "nav_ls" } });
      controls.push(...quickControls);
      controls.push(...feedbackControls);
      controls.push(...allControls);
    } else {
      controls.push(...quickControls);
      controls.push(...feedbackControls);
      const overflowOptions = [];
      if (dirs.length > 0 || files.length > 0) {
        overflowOptions.push(
          { label: "查看全部", value: { action: "nav_show_all" } },
          { label: "仅文件夹", value: { action: "nav_show_folders" } },
          { label: "仅文件", value: { action: "nav_show_files" } }
        );
      }
      overflowOptions.push(...allControls.map((item) => ({ label: item.label, value: item.value, type: item.type })));
      if (overflowOptions.length === 1) {
        const only = overflowOptions[0];
        controls.push({
          label: only.label || "更多",
          type: only.type || "default",
          value: only.value || { action: "noop" }
        });
      } else if (overflowOptions.length > 1) {
        controls.push({
          label: "更多",
          type: "default",
          value: {
            action: "nav_show_more",
            show_folders: showFolders ? 1 : 0,
            show_files: showFiles ? 1 : 0
          }
        });
      }
    }
    console.log(`[trace][nav] controls thread=${chatId} quick=${quickControls.length} total=${controls.length}`);

    if (controlsOnly) {
      await sendCard(chatId, buildNavCard({
        title: "更多操作",
        controls
      }));
      return;
    }

    const summary = [
      `当前目录：\`${resolved}\``,
      `当前工具：\`${activeTool}\``,
      `当前模型：\`${activeModel || "未设置"}\``,
      activeSession ? `当前会话：\`${activeSession}\`` : "",
      `文件夹：${dirs.length}，文件：${files.length}`,
      dirs.length > NAV_DIR_BUTTON_LIMIT ? `文件夹仅展示前 ${NAV_DIR_BUTTON_LIMIT} 个。` : "",
      files.length > NAV_FILE_BUTTON_LIMIT ? `文件仅展示前 ${NAV_FILE_BUTTON_LIMIT} 个。` : "",
      "目录列表仅展示当前目录一级（子目录请点击进入）。"
    ].filter(Boolean).join("\n");

    const decoratedSummary = taskOutput?.content ? `${taskOutput.content}\n\n---\n${summary}` : summary;
    await sendCard(chatId, buildNavCard({ summary: decoratedSummary, controls, folderButtons, fileButtons }));
  }

  async function handleNavigationCommand(chatId, text) {
    const input = String(text || "").trim();
    if (!input) {
      return false;
    }
    const current = getNavigationCwd(chatId);
    console.log(`[trace][nav] command thread=${chatId} input=${JSON.stringify(input)} current=${current}`);

    if (input.toLowerCase() === "cd") {
      await sendDriveRootsCard(chatId);
      return true;
    }
    if (/^(pwd|cwd)$/i.test(input)) {
      await sendText(chatId, `📍 当前目录\n${current}`);
      return true;
    }
    if (isListDirectoryCommand(input) || /^(ls|dir)(\s+.+)?$/i.test(input)) {
      const suffix = isListDirectoryCommand(input) ? "" : input.replace(/^(ls|dir)\s*/i, "").trim();
      const target = suffix ? resolveNavPath(current, suffix) : resolveNavPath(current, current);
      console.log(`[trace][nav] ls thread=${chatId} suffix=${JSON.stringify(suffix)} resolved=${target.path || ""} ok=${target.ok} isDir=${target.isDirectory}`);
      if (!target.ok) {
        await sendText(chatId, `❌ ${target.message || "目录读取失败"}`);
        return true;
      }
      if (!target.isDirectory) {
        await sendText(chatId, `📄 ${target.path}`);
        return true;
      }
      await sendDirectoryCard(chatId, target.path, { showFolders: true, showFiles: true });
      return true;
    }
    if (/^cd(\s+.+)?$/i.test(input)) {
      const suffix = input.replace(/^cd\s*/i, "").trim();
      const rawTarget = resolveCdTarget(current, suffix || current);
      const target = resolveNavPath(current, rawTarget);
      console.log(`[trace][nav] cd thread=${chatId} suffix=${JSON.stringify(suffix)} rawTarget=${rawTarget} resolved=${target.path || ""} ok=${target.ok} isDir=${target.isDirectory}`);
      if (!target.ok) {
        await sendText(chatId, `❌ ${target.message}`);
        return true;
      }
      if (!target.isDirectory) {
        await sendText(chatId, `❌ 不是目录：${target.path}`);
        return true;
      }
      await sendDirectoryCard(chatId, target.path, { showFolders: true, showFiles: true });
      return true;
    }
    if (/^mkdir\s+.+$/i.test(input)) {
      const name = input.replace(/^mkdir\s+/i, "").trim();
      const targetPath = path.resolve(current, name);
      try {
        fs.mkdirSync(targetPath, { recursive: false });
        await sendText(chatId, `✅ 已创建文件夹\n${targetPath}`);
        await sendDirectoryCard(chatId, current, { showFolders: true, showFiles: true });
      } catch (error) {
        await sendText(chatId, `❌ 创建文件夹失败：${error instanceof Error ? error.message : String(error)}`);
      }
      return true;
    }
    return false;
  }

  async function handleNavigationAction(chatId, value, runtimeOps = {}) {
    const action = String(value?.action || "").trim();
    const isAbortAction = action === "abort_task" || action === "abort_and_new_session";
    if (!action.startsWith("nav_")
      && action !== "change_model"
      && action !== "change_model_page"
      && action !== "change_tool"
      && !isAbortAction) {
      if (action) {
        console.log(`[feishu] navigation ignored action=${action}`);
      }
      return false;
    }

    const current = getNavigationCwd(chatId);
    const bindFn = typeof runtimeOps?.bindWorkspace === "function" ? runtimeOps.bindWorkspace : bindWorkspace;
    const requestAbortFn = typeof runtimeOps?.requestRunAbort === "function"
      ? runtimeOps.requestRunAbort
      : requestRunAbort;

    if (action === "change_model") {
      const model = String(value?.value || "").trim();
      if (model) {
        const runtimeProvider = getThreadRuntimeProvider(chatId);
        if (!runtimeProvider?.model || typeof runtimeProvider.model.list !== "function") {
          await sendText(chatId, `❌ 当前工具不支持模型切换：${runtimeProvider.id}`);
          return true;
        }
        const available = await runtimeProvider.model.list(true);
        if (!available.includes(model)) {
          await sendText(chatId, `❌ 模型不可用：${model}（工具：${runtimeProvider.id}）`);
          return true;
        }
        setThreadModel(chatId, model);
        await sendText(chatId, `✅ 模型已切换为 ${model}`);
      }
      return true;
    }
    if (action === "change_model_page") {
      const page = Math.max(0, Number.parseInt(String(value?.page ?? 0), 10) || 0);
      await showModelCard(chatId, { page });
      return true;
    }
    if (action === "change_tool") {
      const toolId = String(value?.value || "").trim().toLowerCase();
      if (!toolId) {
        await sendText(chatId, "❌ 工具ID为空，请重试");
        return true;
      }
      const toolMeta = listRuntimeProviders({ includeUnavailable: true }).find((item) => item.id === toolId);
      if (!toolMeta) {
        await sendText(chatId, `❌ 未知工具：${toolId}`);
        return true;
      }
      if (!isRuntimeProviderAvailable(toolId)) {
        await sendText(chatId, `❌ 工具暂不可用：${toolMeta.label}（${toolMeta.reason || "未配置"}）`);
        return true;
      }
      const restored = switchThreadTool(chatId, toolId);
      const restoredSession = String(restored?.sessionId || "").trim();
      const restoredModel = String(restored?.model || "").trim();
      const runtimeProvider = resolveRuntimeProvider(toolId) || getAgentRuntimeProvider(toolId);
      const preferWhenEmpty = String(runtimeProvider?.id || "").trim().toLowerCase() === "opencode";
      let resolvedModel = restoredModel;
      let modelAdjustNote = "";
      if (runtimeProvider?.model && typeof runtimeProvider.model.list === "function") {
        try {
          let availableModels = normalizeModelList(await runtimeProvider.model.list(false));
          let decision = resolveRequestedModel({
            runtimeId: runtimeProvider.id,
            requestedModel: restoredModel,
            availableModels,
            preferWhenEmpty
          });
          const shouldForceRefresh = (
            (decision.reason === "requested_unavailable" && decision.changed)
            || (preferWhenEmpty && !decision.model)
          );
          if (shouldForceRefresh) {
            const refreshed = normalizeModelList(await runtimeProvider.model.list(true));
            if (refreshed.length > 0) {
              availableModels = refreshed;
              decision = resolveRequestedModel({
                runtimeId: runtimeProvider.id,
                requestedModel: restoredModel,
                availableModels,
                preferWhenEmpty
              });
            }
          }

          const nextModel = String(decision.model || "").trim();
          if (nextModel && nextModel !== restoredModel) {
            setThreadModel(chatId, nextModel);
            resolvedModel = nextModel;
            if (restoredModel) {
              modelAdjustNote = `检测到原模型不可用，已切换为：${nextModel}`;
            } else {
              modelAdjustNote = `已自动选择默认模型：${nextModel}`;
            }
          } else if (!nextModel && restoredModel && availableModels.length > 0) {
            clearThreadModel(chatId);
            resolvedModel = "";
            modelAdjustNote = `原模型不可用，已清空模型配置`;
          }
        } catch (error) {
          modelAdjustNote = `模型可用性校验失败：${error instanceof Error ? error.message : String(error)}`;
        }
      }
      const details = [];
      details.push(`✅ 工具已切换为 ${toolMeta.label}（${toolId}）`);
      if (restoredSession) {
        details.push(`已恢复上次会话：${restoredSession}`);
      } else {
        details.push("该工具暂无历史会话，请先选择或新建会话。");
      }
      if (resolvedModel) {
        details.push(`已恢复上次模型：${resolvedModel}`);
      }
      if (modelAdjustNote) {
        details.push(modelAdjustNote);
      }
      await sendText(chatId, details.join("\n"));
      return true;
    }
    if (action === "abort_task") {
      const run = latestQueuedRunForThread(chatId, ["running", "pending"]);
      if (!run) {
        const snapshot = queuedRunSnapshot();
        console.log(`[feishu] abort_task no-active-run chat=${chatId} snapshot=${JSON.stringify(snapshot)}`);
        await sendText(chatId, "ℹ️ 当前没有可中止的任务");
        return true;
      }
      const result = await abortRunWithSdk(run, requestAbortFn);
      const warning = String(result?.warning || "").trim();
      await sendText(chatId, `⏹ 已请求中止任务\n\nrunId: ${run.runId}`);
      if (warning) {
        await sendText(chatId, `⚠️ 中止已提交，但服务端返回提示：${warning}`);
      }
      return true;
    }
    if (action === "abort_and_new_session") {
      const run = latestQueuedRunForThread(chatId, ["running", "pending"]);
      if (run) {
        await abortRunWithSdk(run, requestAbortFn);
      }
      const binding = getBinding(chatId);
      if (!binding?.repoPath) {
        await sendText(chatId, "❌ 当前未绑定工作空间，无法新建会话");
        return true;
      }
      const runtimeProvider = getThreadRuntimeProvider(chatId);
      if (!runtimeProvider?.session || typeof runtimeProvider.session.create !== "function") {
        await sendText(chatId, `❌ 工具 ${runtimeProvider.id} 不支持新建会话`);
        return true;
      }
      const created = await runtimeProvider.session.create(binding.repoPath, `${path.basename(binding.repoPath)}-${Date.now()}`);
      setThreadSession(chatId, created.id);
      await sendText(chatId, `🆕 已终止并切换到新会话\n\n当前会话：${created.id}`);
      await sendDirectoryCard(chatId, binding.repoPath, { showFolders: true, showFiles: true });
      return true;
    }
    if (action === "nav_roots") {
      await sendDriveRootsCard(chatId);
      return true;
    }
    if (action === "nav_ls") {
      await sendDirectoryCard(chatId, current, { showFolders: true, showFiles: true });
      return true;
    }
    if (action === "nav_show_folders") {
      await sendDirectoryCard(chatId, current, { showFolders: true, showFiles: false });
      return true;
    }
    if (action === "nav_show_files") {
      await sendDirectoryCard(chatId, current, { showFolders: false, showFiles: true });
      return true;
    }
    if (action === "nav_show_all") {
      await sendDirectoryCard(chatId, current, { showFolders: true, showFiles: true });
      return true;
    }
    if (action === "nav_show_more") {
      await sendDirectoryCard(chatId, current, {
        showFolders: Number(value?.show_folders || 0) === 1,
        showFiles: Number(value?.show_files || 0) === 1,
        expandedControls: true,
        controlsOnly: true
      });
      return true;
    }
    if (action === "nav_up") {
      await sendDirectoryCard(chatId, path.resolve(current, ".."), { showFolders: true, showFiles: true });
      return true;
    }
    if (action === "nav_cd") {
      const target = resolveNavToken(chatId, value?.token) || resolveCdTarget(current, String(value?.target || ""));
      if (!target || !fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
        await sendText(chatId, `❌ 路径不存在或不是目录：${target || "(空)"}`);
        return true;
      }
      await sendDirectoryCard(chatId, target, { showFolders: true, showFiles: true });
      return true;
    }
    if (action === "nav_file") {
      const filePath = resolveNavToken(chatId, value?.token);
      if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        await sendText(chatId, "❌ 文件不存在或已失效，请刷新后重试");
        return true;
      }
      await showFileInfo(chatId, filePath);
      return true;
    }
    if (action === "nav_file_send") {
      const filePath = resolveNavToken(chatId, value?.token);
      if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        await sendText(chatId, "❌ 文件不存在或已失效，请刷新后重试");
        return true;
      }
      try {
        await sendFileFromFile(chatId, filePath);
        await sendText(chatId, `✅ 文件已发送：\`${filePath}\``);
      } catch (error) {
        await sendText(chatId, `❌ 发送文件失败：${error instanceof Error ? error.message : String(error)}`);
      }
      return true;
    }
    if (action === "nav_file_delete_bind_required") {
      await sendText(chatId, "❌ 当前未绑定工作空间，无法删除。请先 `/oc bind <repoPath> [branch]`。");
      return true;
    }
    if (action === "nav_file_delete_confirm") {
      const filePath = resolveNavToken(chatId, value?.token);
      if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        await sendText(chatId, "❌ 文件不存在或已失效，请刷新后重试");
        return true;
      }
      fs.unlinkSync(filePath);
      await sendText(chatId, `✅ 已删除文件：\`${filePath}\``);
      await sendDirectoryCard(chatId, path.dirname(filePath), { showFolders: true, showFiles: true });
      return true;
    }
    if (action === "nav_bind") {
      if (typeof bindFn !== "function") {
        await sendText(chatId, "❌ 绑定入口未就绪，请稍后重试");
        return true;
      }
      await bindFn(chatId, current, "main");
      setThreadPath(chatId, current);
      await sendText(chatId, `✅ 工作区已绑定\n\n路径：${current}\n分支：main`);
      await sendDirectoryCard(chatId, current, { showFolders: true, showFiles: true });
      return true;
    }
    if (action === "nav_unbind") {
      clearBinding(chatId);
      await sendText(chatId, "✅ 已解绑当前工作空间");
      await sendDirectoryCard(chatId, current, { showFolders: true, showFiles: true });
      return true;
    }
    if (action === "nav_workspace_home") {
      const binding = getBinding(chatId);
      if (!binding?.repoPath) {
        await sendText(chatId, "❌ 当前未绑定工作空间");
        return true;
      }
      await sendDirectoryCard(chatId, binding.repoPath, { showFolders: true, showFiles: true });
      return true;
    }
    if (action === "nav_sessions") {
      const binding = getBinding(chatId);
      if (!binding?.repoPath) {
        await sendText(chatId, "❌ 当前未绑定工作空间，无法选择会话");
        return true;
      }
      await sendSessionSelectCard(chatId, binding.repoPath);
      return true;
    }
    if (action === "nav_new_session") {
      const binding = getBinding(chatId);
      if (!binding?.repoPath) {
        await sendText(chatId, "❌ 当前未绑定工作空间，无法创建会话");
        return true;
      }
      const previousSession = getThreadSession(chatId);
      const runtimeProvider = getThreadRuntimeProvider(chatId);
      if (!runtimeProvider?.session || typeof runtimeProvider.session.create !== "function") {
        await sendText(chatId, `❌ 工具 ${runtimeProvider.id} 不支持新建会话`);
        return true;
      }
      const created = await runtimeProvider.session.create(binding.repoPath, `${path.basename(binding.repoPath)}-${Date.now()}`);
      setThreadSession(chatId, created.id);
      console.log(`[trace][session] nav_new_session thread=${chatId} repo=${binding.repoPath} previousSession=${previousSession || ""} newSession=${created.id}`);
      await sendText(chatId, `✅ 已切换到新会话\n\n会话ID：${created.id}`);
      await sendDirectoryCard(chatId, binding.repoPath, { showFolders: true, showFiles: true });
      return true;
    }
    if (action === "nav_session_pick") {
      const sid = String(value?.sid || "").trim();
      if (!sid) {
        await sendText(chatId, "❌ 会话ID缺失，请重试");
        return true;
      }
      const previousSession = getThreadSession(chatId);
      setThreadSession(chatId, sid);
      console.log(`[trace][session] nav_session_pick thread=${chatId} previousSession=${previousSession || ""} pickedSession=${sid}`);
      await sendText(chatId, `✅ 已切换会话\n\n当前会话：${sid}`);
      await sendDirectoryCard(chatId, current, { showFolders: true, showFiles: true });
      return true;
    }
    if (action === "nav_model_select") {
      const binding = getBinding(chatId);
      if (!binding?.repoPath) {
        await sendText(chatId, "❌ 当前未绑定工作空间，无法切换模型");
        return true;
      }
      await showModelCard(chatId);
      return true;
    }
    if (action === "nav_tool_select") {
      const binding = getBinding(chatId);
      if (!binding?.repoPath) {
        await sendText(chatId, "❌ 当前未绑定工作空间，无法切换工具");
        return true;
      }
      if (typeof showToolCard !== "function") {
        await sendText(chatId, "❌ 工具选择入口未就绪，请稍后重试");
        return true;
      }
      await showToolCard(chatId);
      return true;
    }
    if (action === "nav_mkdir_help") {
      await sendText(chatId, "ℹ️ 请直接发送命令：`mkdir 文件夹名`，会在当前目录创建。 ");
      return true;
    }

    return false;
  }

  return {
    getNavigationCwd,
    handleNavigationCommand,
    handleNavigationAction,
    sendDirectoryCard
  };
}
