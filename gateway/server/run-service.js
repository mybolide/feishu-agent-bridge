import fs from "node:fs";
import path from "node:path";
import {
  buildTaskResultNavigatorCard,
  dispatchInteractiveCard,
  sendText,
  shouldRenderResultAsMarkdownCard
} from "../feishu/core/runtime.js";
import { getDefaultRuntimeProviderId, resolveRuntimeProvider } from "../agent-runtime/index.js";
import { createOpenCodeProgressCard } from "../agent-runtime/opencode/progress-card.js";
import { shouldRetryInCurrentSession, shouldRetryWithFreshSession } from "./retry-policy.js";
import { resolveBoundSessionForRun } from "./session-policy.js";
import {
  clearThreadModel,
  clearThreadSession,
  clearThreadToolState,
  getBinding,
  getQueuedRun,
  getRunRef,
  getThreadSession,
  getThreadTool,
  latestQueuedRunForThread,
  patchQueuedRun,
  patchRunRef,
  reconcileQueuedRunsOnStartup,
  saveRunRef,
  setThreadModel,
  setThreadSession,
  upsertBinding,
  upsertQueuedRun
} from "../state/store.js";
import { normalizeModelList, resolveRequestedModel } from "../agent-runtime/model-routing.js";

const THREAD_RUN_CHAINS = new Map();
const RUN_ABORT_CONTROLLERS = new Map();
const IFLOW_UNHEALTHY_SESSIONS = new Map();
const PROGRESS_HEARTBEAT_MS = 5000;
const STREAM_PROGRESS_UPDATE_MIN_INTERVAL_MS = 1200;
const STREAM_PROGRESS_MIN_DELTA_CHARS = 48;
const STREAM_PROGRESS_PREVIEW_MAX_CHARS = 1200;
const IFLOW_UNHEALTHY_SESSION_TTL_MS = Math.max(
  60 * 1000,
  Number.parseInt(String(process.env.IFLOW_UNHEALTHY_SESSION_TTL_MS || 30 * 60 * 1000), 10) || (30 * 60 * 1000)
);
const IFLOW_SAME_SESSION_RETRY_DELAY_MS = Math.max(
  300,
  Number.parseInt(String(process.env.IFLOW_SAME_SESSION_RETRY_DELAY_MS || 1200), 10) || 1200
);
const QUEUED_COMMAND_PREVIEW_MAX_CHARS = 120;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

function markIFlowSessionUnhealthy(sessionId, reason = "") {
  const key = String(sessionId || "").trim();
  if (!key) {
    return;
  }
  const expiresAt = Date.now() + IFLOW_UNHEALTHY_SESSION_TTL_MS;
  IFLOW_UNHEALTHY_SESSIONS.set(key, expiresAt);
  console.warn(`[trace][iflow] mark session unhealthy session=${key} ttlMs=${IFLOW_UNHEALTHY_SESSION_TTL_MS} reason=${reason || "unknown"}`);
}

function isIFlowSessionUnhealthy(sessionId) {
  const key = String(sessionId || "").trim();
  if (!key) {
    return false;
  }
  const expiresAt = Number(IFLOW_UNHEALTHY_SESSIONS.get(key) || 0);
  if (expiresAt <= 0) {
    return false;
  }
  if (expiresAt <= Date.now()) {
    IFLOW_UNHEALTHY_SESSIONS.delete(key);
    return false;
  }
  return true;
}

function resolveReusableSession(threadId, runtimeId = "") {
  const activeSession = getThreadSession(threadId);
  console.log(`[trace][session] resolveReusableSession thread=${threadId} bound=${activeSession || ""} runtime=${runtimeId || ""}`);
  const reusableSession = resolveBoundSessionForRun({
    sessionId: activeSession,
    runtimeId,
    unhealthy: runtimeId === "iflow-cli" && isIFlowSessionUnhealthy(activeSession)
  });
  if (reusableSession) {
    console.log(`[trace][session] resolveReusableSession reuse-bound thread=${threadId} session=${reusableSession}`);
    return reusableSession;
  }
  if (activeSession && runtimeId === "iflow-cli") {
    console.warn(`[trace][iflow] skip unhealthy bound session thread=${threadId} session=${activeSession}`);
  }
  console.log(`[trace][session] resolveReusableSession no-bound-session-reused thread=${threadId}`);
  return "";
}

function isFeishuThreadTarget(threadId) {
  const value = String(threadId || "").trim();
  if (!value) {
    return false;
  }
  return /^(oc_|ou_|on_|chat:|group:|user:|open_id:|feishu:|lark:)/i.test(value) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function summarizeQueuedCommand(command) {
  const value = String(command || "").replace(/\s+/g, " ").trim();
  if (!value) {
    return "";
  }
  return value.length > QUEUED_COMMAND_PREVIEW_MAX_CHARS
    ? `${value.slice(0, QUEUED_COMMAND_PREVIEW_MAX_CHARS)}...`
    : value;
}

function appendQueuedRunHint(detail, queuedRun) {
  const base = String(detail || "").trim();
  const followUp = summarizeQueuedCommand(queuedRun?.pendingFollowUpCommand);
  if (!followUp) {
    return base;
  }
  const note = `收到新消息，待当前任务完成后继续：${followUp}`;
  return base ? `${base}\n\n${note}` : note;
}

function isRunAborted(runId) {
  return getQueuedRun(runId)?.status === "aborted";
}

function createRunAbortController(runId) {
  const controller = new AbortController();
  RUN_ABORT_CONTROLLERS.set(runId, controller);
  return controller;
}

function clearRunAbortController(runId) {
  RUN_ABORT_CONTROLLERS.delete(runId);
}

async function dispatchAbortedProgressCard(threadId, runStartedAt, progressMessageId, detail) {
  return await dispatchInteractiveCard(threadId, createOpenCodeProgressCard({
    status: "aborted",
    elapsedSeconds: Math.floor((Date.now() - runStartedAt) / 1000),
    detail: detail || "任务已中止"
  }), {
    messageId: progressMessageId,
    allowFallbackSend: true
  });
}

export function requestRunAbort(runId, reason = "abort requested") {
  const key = String(runId || "").trim();
  if (!key) {
    return false;
  }
  const controller = RUN_ABORT_CONTROLLERS.get(key);
  if (!controller) {
    return false;
  }
  if (!controller.signal.aborted) {
    controller.abort(new Error(reason));
  }
  return true;
}

function startProgressHeartbeat({ runId, threadId, command, getMessageId, getDetail }) {
  const startedAt = Date.now();
  let stopped = false;
  let inflight = Promise.resolve();

  const tick = async () => {
    const messageId = String(getMessageId() || "").trim();
    if (stopped || !messageId) {
      return;
    }
    const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
    const queuedRun = getQueuedRun(runId);
    const detail = appendQueuedRunHint(typeof getDetail === "function"
      ? String(getDetail() || "").trim()
      : "", queuedRun);
    const latestOutput = String(queuedRun?.latestOutput || "").trim();
    await dispatchInteractiveCard(threadId, createOpenCodeProgressCard({
      status: "running",
      elapsedSeconds,
      detail: detail || `命令：${command}`,
      latestOutput
    }), {
      messageId,
      allowFallbackSend: false
    });
  };

  const timer = setInterval(() => {
    inflight = inflight.catch(() => undefined).then(async () => {
      try {
        await tick();
      } catch (error) {
        console.error("[opencode] progress heartbeat update failed", error);
      }
    });
  }, PROGRESS_HEARTBEAT_MS);

  if (typeof timer.unref === "function") {
    timer.unref();
  }

  return async () => {
    stopped = true;
    clearInterval(timer);
    await inflight.catch(() => undefined);
  };
}

export async function reconcileStaleRunCardsOnStartup() {
  const staleRuns = reconcileQueuedRunsOnStartup();
  for (const row of staleRuns) {
    const threadId = String(row.threadId || "").trim();
    if (!threadId || !isFeishuThreadTarget(threadId)) {
      continue;
    }
    const sessionId = String(row.sessionId || "").trim();
    const messageId = String(row.progressMessageId || "").trim();
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - Number(row.createdAt || Date.now())) / 1000));
    const detail = `任务因网关重启已中断${sessionId ? `\n会话：${sessionId}` : ""}`;
    try {
      if (messageId) {
        await dispatchInteractiveCard(threadId, createOpenCodeProgressCard({
          status: "failed",
          elapsedSeconds,
          detail
        }), {
          messageId,
          allowFallbackSend: false
        });
      } else {
        await sendText(threadId, `⚠️ 上次任务因网关重启已中断。${sessionId ? `\n会话：${sessionId}` : ""}`);
      }
    } catch (error) {
      console.error(`[opencode] failed to reconcile stale run card run=${row.runId}`, error);
    }
  }
}

function buildRunContextDetail(command, repoPath, streamPreview = "") {
  const cmd = String(command || "").trim();
  const repo = String(repoPath || "").trim();
  const preview = String(streamPreview || "").trim();
  const parts = [];
  if (repo) {
    parts.push(`工作目录：${repo}`);
  }
  if (cmd) {
    parts.push(`命令：${cmd}`);
  }
  if (preview) {
    parts.push(preview);
  }
  return parts.join("\n\n");
}

export function mergeProgressOutput(previousOutput, previousRawText, nextRawText) {
  const previous = String(previousOutput || "").trim();
  const previousRaw = String(previousRawText || "").trim();
  const next = String(nextRawText || "").trim();
  if (!next) {
    return previous;
  }
  if (!previous) {
    return next;
  }
  if (next === previousRaw) {
    return previous;
  }
  if (previousRaw && next.startsWith(previousRaw) && previous.endsWith(previousRaw)) {
    return `${previous.slice(0, previous.length - previousRaw.length)}${next}`.trim();
  }
  if (previous.endsWith(next) || previous.includes(`\n\n${next}`)) {
    return previous;
  }
  return `${previous}\n\n${next}`.trim();
}

function resolveFinalOutput(output, latestOutput) {
  const finalText = String(output || "").trim();
  const progressText = String(latestOutput || "").trim();
  return finalText || progressText || "";
}

function buildRuntimeInput(command, repoPath) {
  const userCommand = String(command || "").trim();
  const workspace = String(repoPath || "").trim();
  if (!workspace) {
    return userCommand;
  }
  return [
    "你正在执行一个已绑定工作空间任务。",
    `工作目录：${workspace}`,
    "要求：只能基于该目录进行判断与操作，不要假设或切换到其他目录。",
    "",
    `用户请求：${userCommand}`
  ].join("\n");
}

async function safeListRuntimeModels(runtimeProvider, forceRefresh = false) {
  if (!runtimeProvider?.model || typeof runtimeProvider.model.list !== "function") {
    return [];
  }
  try {
    const rows = await runtimeProvider.model.list(Boolean(forceRefresh));
    return normalizeModelList(rows);
  } catch (error) {
    console.warn(
      `[trace][model] list failed runtime=${runtimeProvider.id} forceRefresh=${forceRefresh ? 1 : 0} message=${error instanceof Error ? error.message : String(error)}`
    );
    return [];
  }
}

async function resolveRuntimeModel(threadId, runtimeProvider, requestedModelRaw) {
  const runtimeId = String(runtimeProvider?.id || "").trim().toLowerCase();
  const requestedModel = String(requestedModelRaw || "").trim();
  const preferWhenEmpty = runtimeId === "opencode";

  if (!runtimeProvider?.model || typeof runtimeProvider.model.list !== "function") {
    return { model: requestedModel, note: "" };
  }

  let availableModels = await safeListRuntimeModels(runtimeProvider, false);
  let decision = resolveRequestedModel({
    runtimeId,
    requestedModel,
    availableModels,
    preferWhenEmpty
  });

  const shouldForceRefresh = (
    (decision.reason === "requested_unavailable" && decision.changed)
    || (preferWhenEmpty && !decision.model)
  );
  if (shouldForceRefresh) {
    const refreshed = await safeListRuntimeModels(runtimeProvider, true);
    if (refreshed.length > 0) {
      availableModels = refreshed;
      decision = resolveRequestedModel({
        runtimeId,
        requestedModel,
        availableModels,
        preferWhenEmpty
      });
    }
  }

  const finalModel = String(decision.model || "").trim();
  if (!requestedModel && !finalModel && !preferWhenEmpty) {
    return { model: "", note: "" };
  }

  if (requestedModel && !finalModel && availableModels.length === 0) {
    // Model catalog unavailable: keep current model to avoid false negatives.
    return { model: requestedModel, note: "" };
  }

  if (runtimeId === "opencode" && !finalModel) {
    throw new Error("OpenCode 暂无可用模型，请先在 OpenCode 端配置可用模型后再重试。");
  }

  if (finalModel && finalModel !== requestedModel) {
    setThreadModel(threadId, finalModel);
    if (requestedModel) {
      return {
        model: finalModel,
        note: `⚠️ 模型 ${requestedModel} 当前不可用，已自动切换为 ${finalModel}`
      };
    }
    return {
      model: finalModel,
      note: `ℹ️ 未设置模型，已自动使用 ${finalModel}`
    };
  }

  if (requestedModel && !finalModel) {
    clearThreadModel(threadId);
    return {
      model: "",
      note: `⚠️ 模型 ${requestedModel} 当前不可用，已清空模型配置`
    };
  }

  return { model: finalModel || requestedModel, note: "" };
}

export function bindThread(threadId, repoPathRaw, branch) {
  const preparedPath = String(repoPathRaw || "").trim().split("\\").join("/");
  let repoPath = /^[A-Za-z]:\//.test(preparedPath) ? preparedPath : path.resolve(preparedPath);
  try {
    const realpath = fs.realpathSync.native || fs.realpathSync;
    repoPath = realpath(repoPath);
  } catch {
    // keep resolved path when realpath is unavailable
  }

  const previousSession = getThreadSession(threadId);
  console.log(`[trace][session] bindThread thread=${threadId} repo=${repoPath} branch=${branch} previousSession=${previousSession || ""}`);
  clearThreadToolState(threadId);
  clearThreadSession(threadId);
  return upsertBinding(threadId, repoPath, branch);
}

export async function executeRun(threadId, command, model, toolId = "") {
  const prev = THREAD_RUN_CHAINS.get(threadId) || Promise.resolve();
  const hasActiveChain = THREAD_RUN_CHAINS.has(threadId);
  if (hasActiveChain) {
    const activeRun = latestQueuedRunForThread(threadId, ["running", "pending"]);
    if (activeRun?.runId) {
      const pendingFollowUpCommand = String(command || "").trim();
      patchQueuedRun(activeRun.runId, {
        pendingFollowUpCommand,
        updatedAt: Date.now()
      });
      if (isFeishuThreadTarget(threadId)) {
        const progressMessageId = String(activeRun.progressMessageId || "").trim();
        const elapsedSeconds = Math.max(0, Math.floor((Date.now() - Number(activeRun.createdAt || Date.now())) / 1000));
        const detail = appendQueuedRunHint(
          buildRunContextDetail(activeRun.command, activeRun.directory),
          { pendingFollowUpCommand }
        );
        const latestOutput = String(activeRun.latestOutput || "").trim();
        Promise.resolve().then(async () => {
          try {
            if (progressMessageId) {
              await dispatchInteractiveCard(threadId, createOpenCodeProgressCard({
                status: "running",
                elapsedSeconds,
                detail,
                latestOutput
              }), {
                messageId: progressMessageId,
                allowFallbackSend: false
              });
            } else {
              await sendText(
                threadId,
                `ℹ️ 上一轮仍在执行，已收到你的新消息并排队：${summarizeQueuedCommand(pendingFollowUpCommand)}`
              );
            }
          } catch (error) {
            console.warn(`[trace][session] pending-followup notify failed thread=${threadId}`, error);
          }
        });
      }
    }
  }
  const current = prev
    .catch(() => undefined)
    .then(() => executeRunUnsafe(threadId, command, model, toolId));
  THREAD_RUN_CHAINS.set(threadId, current);

  try {
    return await current;
  } finally {
    if (THREAD_RUN_CHAINS.get(threadId) === current) {
      THREAD_RUN_CHAINS.delete(threadId);
    }
  }
}

async function executeRunUnsafe(threadId, command, model, toolId = "") {
  const binding = getBinding(threadId);
  if (!binding) {
    throw new Error("workspace not bound, please bind first");
  }
  const requestedToolId = String(toolId || getThreadTool(threadId) || getDefaultRuntimeProviderId()).trim().toLowerCase();
  const runtimeProvider = resolveRuntimeProvider(requestedToolId);
  if (!runtimeProvider) {
    throw new Error(`runtime provider not available: ${requestedToolId}`);
  }
  const requestedModel = String(model || "").trim();
  const { model: effectiveModel, note: modelResolutionNote } = await resolveRuntimeModel(
    threadId,
    runtimeProvider,
    requestedModel
  );

  const boundSessionBefore = getThreadSession(threadId);
  console.log(
    `[trace][session] executeRunUnsafe start thread=${threadId} repo=${binding.repoPath} boundBefore=${boundSessionBefore || ""}`
    + ` runtime=${runtimeProvider.id} requestedModel=${requestedModel || ""} model=${effectiveModel || ""}`
    + ` command=${JSON.stringify(command.slice(0, 120))}`
  );

  let sessionId = resolveReusableSession(threadId, runtimeProvider.id);
  if (!sessionId) {
    try {
      const created = await runtimeProvider.session.create(binding.repoPath, `feishu-${path.basename(binding.repoPath)}-${Date.now()}`);
      sessionId = created.id;
      console.log(`[trace][session] executeRunUnsafe created-new thread=${threadId} session=${sessionId} title=${JSON.stringify(String(created.title || ""))}`);
    } catch (error) {
      throw error;
    }
  }

  console.log(`[trace][session] executeRunUnsafe final-session thread=${threadId} session=${sessionId} boundBefore=${boundSessionBefore || ""}`);
  setThreadSession(threadId, sessionId);

  const runId = `${threadId}:${Date.now()}`;
  const runRef = {
    runId,
    threadId,
    sessionId,
    runtimeId: runtimeProvider.id,
    toolId: runtimeProvider.id,
    directory: binding.repoPath,
    createdAt: Date.now(),
    progressMessageId: ""
  };
  saveRunRef(runRef);

  const runStartedAt = Date.now();
  const queuedRun = {
    runId,
    threadId,
    directory: binding.repoPath,
    command,
    model: effectiveModel,
    runtimeId: runtimeProvider.id,
    toolId: runtimeProvider.id,
    sessionId,
    progressMessageId: "",
    latestOutput: "",
    pendingFollowUpCommand: "",
    status: "running",
    createdAt: runStartedAt,
    updatedAt: runStartedAt
  };
  upsertQueuedRun(queuedRun);
  const abortController = createRunAbortController(runId);

  let progressMessageId = "";
  let stopProgressHeartbeat = null;
  const shouldSendFeishuCard = isFeishuThreadTarget(threadId);
  let liveProgressDetail = buildRunContextDetail(command, binding.repoPath);
  if (modelResolutionNote) {
    liveProgressDetail = `${liveProgressDetail}\n\n${modelResolutionNote}`;
  }
  let lastStreamText = "";
  let lastStreamUpdateAt = 0;

  if (shouldSendFeishuCard) {
    try {
      const progressResp = await dispatchInteractiveCard(threadId, createOpenCodeProgressCard({
        status: "running",
        elapsedSeconds: 0,
        detail: liveProgressDetail
      }), { allowFallbackSend: true });
      progressMessageId = String(progressResp?.messageId || "").trim();
      if (progressMessageId) {
        patchRunRef(runId, { progressMessageId });
        patchQueuedRun(runId, { progressMessageId });
        stopProgressHeartbeat = startProgressHeartbeat({
          runId,
          threadId,
          command,
          getMessageId: () => progressMessageId,
          getDetail: () => liveProgressDetail
        });
      }
    } catch (error) {
      console.error("[opencode] failed to send progress card", error);
    }
  }

  const pushStreamProgress = async (text, completed = false) => {
    if (!shouldSendFeishuCard || !progressMessageId) {
      return;
    }
    const value = String(text || "").trim();
    if (!value) {
      return;
    }
    const now = Date.now();
    const delta = Math.max(0, value.length - lastStreamText.length);
    if (!completed) {
      if (value === lastStreamText) {
        return;
      }
      if ((now - lastStreamUpdateAt) < STREAM_PROGRESS_UPDATE_MIN_INTERVAL_MS && delta < STREAM_PROGRESS_MIN_DELTA_CHARS) {
        return;
      }
    }
    const mergedOutput = mergeProgressOutput(
      String(getQueuedRun(runId)?.latestOutput || ""),
      lastStreamText,
      value
    );
    const preview = mergedOutput.length > STREAM_PROGRESS_PREVIEW_MAX_CHARS
      ? `...${mergedOutput.slice(-STREAM_PROGRESS_PREVIEW_MAX_CHARS)}`
      : mergedOutput;
    liveProgressDetail = buildRunContextDetail(command, binding.repoPath, preview);
    lastStreamText = value;
    lastStreamUpdateAt = now;
    patchQueuedRun(runId, { latestOutput: mergedOutput, updatedAt: now });
    await dispatchInteractiveCard(threadId, createOpenCodeProgressCard({
      status: "running",
      elapsedSeconds: Math.floor((Date.now() - runStartedAt) / 1000),
      detail: appendQueuedRunHint(liveProgressDetail, getQueuedRun(runId)),
      latestOutput: mergedOutput
    }), {
      messageId: progressMessageId,
      allowFallbackSend: false
    });
  };

  const isAbortLikeError = typeof runtimeProvider?.run?.isAbortLikeError === "function"
    ? runtimeProvider.run.isAbortLikeError
    : () => false;
  let activeSessionId = sessionId;

  try {
    console.log(`[trace][session] executeRunUnsafe send thread=${threadId} run=${runId} session=${activeSessionId} repo=${binding.repoPath}`);
    const promptInvokeStartedAt = Date.now();
    let firstProgressAt = 0;
    let progressUpdates = 0;
    let lastProgressLen = 0;
    let output = "";
    let sendAttempt = 0;
    const runtimeInput = buildRuntimeInput(command, binding.repoPath);
    while (true) {
      try {
        output = await runtimeProvider.run.sendMessage(binding.repoPath, activeSessionId, runtimeInput, effectiveModel, {
          signal: abortController.signal,
          onProgress: async (progress) => {
            const text = String(progress?.text || "");
            if (text) {
              progressUpdates += 1;
              lastProgressLen = text.length;
              if (!firstProgressAt) {
                firstProgressAt = Date.now();
                console.log(`[trace][perf] run-first-progress thread=${threadId} run=${runId} session=${activeSessionId} ttfbMs=${firstProgressAt - promptInvokeStartedAt} textLen=${text.length}`);
              }
            }
            try {
              await pushStreamProgress(text, Boolean(progress?.completed));
            } catch (error) {
              console.warn(`[opencode] stream progress update failed run=${runId}`, error);
            }
          }
        });
        break;
      } catch (error) {
        const retryInCurrentSession = shouldRetryInCurrentSession({
          runtimeId: runtimeProvider.id,
          error,
          attempt: sendAttempt,
          aborted: isRunAborted(runId) || abortController.signal.aborted || isAbortLikeError(error)
        });
        if (retryInCurrentSession) {
          sendAttempt += 1;
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`[trace][iflow] same-session retry run=${runId} session=${activeSessionId} reason=${message}`);
          if (shouldSendFeishuCard && progressMessageId) {
            liveProgressDetail = buildRunContextDetail(
              command,
              binding.repoPath,
              "会话状态同步中，准备在当前会话重试..."
            );
            await dispatchInteractiveCard(threadId, createOpenCodeProgressCard({
              status: "running",
              elapsedSeconds: Math.floor((Date.now() - runStartedAt) / 1000),
              detail: liveProgressDetail,
              latestOutput: String(getQueuedRun(runId)?.latestOutput || "").trim()
            }), {
              messageId: progressMessageId,
              allowFallbackSend: false
            });
          }
          await sleep(IFLOW_SAME_SESSION_RETRY_DELAY_MS);
          continue;
        }
        const retryable = shouldRetryWithFreshSession({
          runtimeId: runtimeProvider.id,
          error,
          attempt: sendAttempt,
          aborted: isRunAborted(runId) || abortController.signal.aborted || isAbortLikeError(error)
        });
        if (!retryable) {
          throw error;
        }
        sendAttempt += 1;
        const prevSessionId = activeSessionId;
        if (runtimeProvider.id === "iflow-cli") {
          markIFlowSessionUnhealthy(prevSessionId, "first-token-timeout");
        }
        try {
          await runtimeProvider.session.abort(binding.repoPath, prevSessionId);
        } catch (abortError) {
          console.warn(`[trace][session] abort stale session failed runtime=${runtimeProvider.id} session=${prevSessionId}`, abortError);
        }
        const created = await runtimeProvider.session.create(binding.repoPath, `retry-${path.basename(binding.repoPath)}-${Date.now()}`);
        activeSessionId = String(created?.id || "").trim();
        if (!activeSessionId) {
          throw new Error("retry session create returned empty session id");
        }
        setThreadSession(threadId, activeSessionId);
        patchRunRef(runId, { sessionId: activeSessionId });
        patchQueuedRun(runId, { sessionId: activeSessionId });
        console.warn(`[trace][session] first-token-timeout retry runtime=${runtimeProvider.id} run=${runId} prevSession=${prevSessionId} newSession=${activeSessionId}`);
        if (shouldSendFeishuCard && progressMessageId) {
          liveProgressDetail = buildRunContextDetail(
            command,
            binding.repoPath,
            "首包超时，已切换新会话自动重试..."
          );
          await dispatchInteractiveCard(threadId, createOpenCodeProgressCard({
            status: "running",
            elapsedSeconds: Math.floor((Date.now() - runStartedAt) / 1000),
            detail: liveProgressDetail,
            latestOutput: String(getQueuedRun(runId)?.latestOutput || "").trim()
          }), {
            messageId: progressMessageId,
            allowFallbackSend: false
          });
        }
      }
    }
    const promptElapsedMs = Date.now() - promptInvokeStartedAt;
    const runTtfbMs = firstProgressAt ? (firstProgressAt - promptInvokeStartedAt) : -1;
    console.log(`[trace][perf] run-prompt-summary thread=${threadId} run=${runId} session=${activeSessionId} elapsedMs=${promptElapsedMs} ttfbMs=${runTtfbMs} progressUpdates=${progressUpdates} lastProgressLen=${lastProgressLen} outputLen=${String(output || "").length}`);
    const outputPreview = String(output || "").replace(/\s+/g, " ").slice(0, 220);
    console.log(`[trace][perf] run-output-preview thread=${threadId} run=${runId} session=${activeSessionId} repo=${binding.repoPath} preview=${JSON.stringify(outputPreview)}`);

    if (stopProgressHeartbeat) {
      await stopProgressHeartbeat();
      stopProgressHeartbeat = null;
    }

    if (isRunAborted(runId) || abortController.signal.aborted) {
      if (shouldSendFeishuCard) {
        const dispatch = await dispatchAbortedProgressCard(
          threadId,
          runStartedAt,
          progressMessageId,
          "任务已中止，已停止继续回复"
        );
        progressMessageId = dispatch.messageId || progressMessageId;
      }
      return {
        runId,
        sessionId: activeSessionId,
        output: "(task aborted)",
        repoPath: binding.repoPath
      };
    }

    patchQueuedRun(runId, { status: "completed" });
    const latestOutput = String(getQueuedRun(runId)?.latestOutput || "").trim();
    const finalOutput = resolveFinalOutput(output, latestOutput);

    if (shouldSendFeishuCard) {
      const resultCard = buildTaskResultNavigatorCard(binding.repoPath, finalOutput, {
        run_id: runId,
        route: runtimeProvider.id,
        session_id: activeSessionId,
        thread_id: threadId,
        markdown: shouldRenderResultAsMarkdownCard(finalOutput)
      });
      const dispatch = await dispatchInteractiveCard(threadId, resultCard, {
        messageId: progressMessageId,
        allowFallbackSend: true
      });
      progressMessageId = dispatch.messageId || progressMessageId;
    }

    return {
      runId,
      sessionId: activeSessionId,
      output: finalOutput,
      repoPath: binding.repoPath
    };
  } catch (error) {
    if (stopProgressHeartbeat) {
      await stopProgressHeartbeat();
      stopProgressHeartbeat = null;
    }

    const message = error instanceof Error ? error.message : String(error);
    const aborted = isRunAborted(runId) || abortController.signal.aborted || isAbortLikeError(error);
    if (aborted) {
      patchQueuedRun(runId, { status: "aborted", error: message || "abort requested" });
      if (shouldSendFeishuCard) {
        try {
          const dispatch = await dispatchAbortedProgressCard(
            threadId,
            runStartedAt,
            progressMessageId,
            message || "任务已中止"
          );
          progressMessageId = dispatch.messageId || progressMessageId;
        } catch (sendError) {
          console.error("[opencode] failed to dispatch aborted card", sendError);
        }
      }
      return {
        runId,
        sessionId,
        output: "(task aborted)",
        repoPath: binding.repoPath
      };
    }

    console.error(`[trace][session] executeRunUnsafe failed thread=${threadId} run=${runId} session=${sessionId} boundBefore=${boundSessionBefore || ""} error=${message}`);
    console.error(`[opencode] run failed thread=${threadId} session=${sessionId} run=${runId}: ${message}`);
    patchQueuedRun(runId, { status: "failed", error: message });
    let failureNotifiedByCard = false;

    if (shouldSendFeishuCard) {
      try {
        const dispatch = await dispatchInteractiveCard(threadId, createOpenCodeProgressCard({
          status: "failed",
          elapsedSeconds: Math.floor((Date.now() - runStartedAt) / 1000),
          detail: message
        }), {
          messageId: progressMessageId,
          allowFallbackSend: true
        });
        progressMessageId = dispatch.messageId || progressMessageId;
        failureNotifiedByCard = true;
      } catch (sendError) {
        console.error("[opencode] failed to dispatch failed card", sendError);
      }
    }

    if (error && typeof error === "object") {
      error.__feishuUserNotified = failureNotifiedByCard;
    }
    throw error;
  } finally {
    clearRunAbortController(runId);
  }
}
