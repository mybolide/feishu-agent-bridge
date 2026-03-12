import * as lark from "@larksuiteoapi/node-sdk";
import crypto from "node:crypto";
import { config } from "../../config/index.js";
import { getBinding, getThreadModel, getThreadTool, setThreadPath } from "../../state/store.js";
import { getAgentRuntimeProvider, getDefaultRuntimeProviderId, listRuntimeProviders } from "../../agent-runtime/index.js";
import { createNavigationHandlers } from "../ui/navigation.js";
import { createOcCommandHandler } from "./commands.js";
import { buildModelCard, buildTaskResultNavigatorCard, buildToolCard, parseTextContent, shouldRenderResultAsMarkdownCard } from "../ui/cards.js";
import { showModelCardFlow } from "./model-card-flow.js";
import {
  addTypingReaction,
  createWsClient,
  dispatchInteractiveCard,
  preflightLongConnection,
  removeTypingReaction,
  sendCard,
  sendFileFromFile,
  sendText,
  deleteMessage,
  updateCard
} from "../sdk/messenger.js";

const EVENT_DEDUP_STORE = new Map();
const EVENT_DEDUP_TTL_MS = Number.parseInt(String(process.env.REDIS_EVENT_DEDUP_TTL_SECONDS || 600), 10) * 1000;
const CARD_NO_EVENT_TTL_MS = Number.parseInt(String(process.env.FEISHU_CARD_ACTION_NO_EVENT_DEDUP_TTL_SECONDS || 3), 10) * 1000;
const CARD_EVENT_TYPES = new Set(["im.message.action_card_v1", "card.action.trigger", "card.action.trigger_v1", "card.action.v1"]);
const WS_HEALTH_LOG_INTERVAL_MS = Math.max(
  5000,
  Number.parseInt(String(process.env.FEISHU_WS_HEALTH_LOG_INTERVAL_MS || 30000), 10) || 30000
);

let wsStarted = false;
let wsClient = null;
let wsHealthTimer = null;
const wsEventStats = {
  total: 0,
  lastEventAt: 0,
  lastEventType: ""
};

function cleanupEventDedup() {
  const now = Date.now();
  for (const [key, expiresAt] of EVENT_DEDUP_STORE.entries()) {
    if ((expiresAt || 0) <= now) {
      EVENT_DEDUP_STORE.delete(key);
    }
  }
}

function dedupOnce(key, ttlMs) {
  const norm = String(key || "").trim();
  if (!norm) {
    return false;
  }
  cleanupEventDedup();
  if (EVENT_DEDUP_STORE.has(norm)) {
    return true;
  }
  EVENT_DEDUP_STORE.set(norm, Date.now() + Math.max(1000, ttlMs || 1000));
  return false;
}

function actionFingerprint(chatId, sourceMessageId, action) {
  const raw = `${String(chatId || "").trim()}|${String(sourceMessageId || "").trim()}|${JSON.stringify(action || {})}`;
  return `card_action_no_event:${crypto.createHash("sha256").update(raw).digest("hex")}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms || 0)));
}

function formatEpochMs(epochMs) {
  const value = Number(epochMs || 0);
  if (!Number.isFinite(value) || value <= 0) {
    return "";
  }
  return new Date(value).toISOString();
}

function markEvent(eventType) {
  wsEventStats.total += 1;
  wsEventStats.lastEventAt = Date.now();
  wsEventStats.lastEventType = String(eventType || "").trim();
}

function startWsHealthLogLoop(client) {
  if (wsHealthTimer) {
    clearInterval(wsHealthTimer);
    wsHealthTimer = null;
  }
  wsHealthTimer = setInterval(() => {
    try {
      const reconnectInfo = client?.getReconnectInfo?.() || {};
      const lastConnectTime = Number(reconnectInfo.lastConnectTime || 0);
      const nextConnectTime = Number(reconnectInfo.nextConnectTime || 0);
      const connected = lastConnectTime > 0 && nextConnectTime === 0;
      console.log(
        `[feishu] ws health connected=${connected ? 1 : 0}`
        + ` last_connect=${formatEpochMs(lastConnectTime) || "n/a"}`
        + ` next_connect=${formatEpochMs(nextConnectTime) || "n/a"}`
        + ` events_total=${wsEventStats.total}`
        + ` last_event_type=${wsEventStats.lastEventType || "n/a"}`
        + ` last_event_at=${formatEpochMs(wsEventStats.lastEventAt) || "n/a"}`
      );
    } catch (error) {
      console.warn("[feishu] ws health check failed", error);
    }
  }, WS_HEALTH_LOG_INTERVAL_MS);
  if (typeof wsHealthTimer.unref === "function") {
    wsHealthTimer.unref();
  }
}

export { sendText, sendCard, deleteMessage, updateCard, dispatchInteractiveCard };
export { shouldRenderResultAsMarkdownCard, buildTaskResultNavigatorCard };

export async function showModelCard(chatId, options = {}) {
  await showModelCardFlow(chatId, {
    getSelectedTool: (targetChatId) => getThreadTool(targetChatId) || getDefaultRuntimeProviderId(),
    getProvider: (toolId) => getAgentRuntimeProvider(toolId),
    getCurrentModel: (targetChatId) => getThreadModel(targetChatId),
    buildModelCard,
    dispatchInteractiveCard
  }, options);
}

export async function showToolCard(chatId) {
  const current = getThreadTool(chatId) || getDefaultRuntimeProviderId();
  const providers = listRuntimeProviders({ includeUnavailable: true });
  await sendCard(chatId, buildToolCard(current, providers));
}

export async function sendTaskResultWithNavigator(chatId, targetPath, taskOutput, taskFeedback = {}) {
  setThreadPath(chatId, targetPath);
  await sendCard(chatId, buildTaskResultNavigatorCard(targetPath, taskOutput, taskFeedback));
}

const navigationHandlers = createNavigationHandlers({
  sendText,
  sendCard,
  sendFileFromFile,
  showModelCard,
  showToolCard,
  bindWorkspace: async () => {
    throw new Error("bind workspace function not configured");
  },
  requestRunAbort: () => false
});

async function processMessageEvent(normalized, event, header, run, bind) {
  const message = (event.message && typeof event.message === "object") ? event.message : {};
  const chatId = String(message.chat_id || "").trim();
  const messageId = String(message.message_id || event.message_id || normalized.message_id || "").trim();
  const eventId = String(normalized.event_id || header.event_id || event.event_id || "").trim();
  const text = parseTextContent(message.content);

  console.log(`[feishu] inbound chat=${chatId} message_id=${messageId} event_id=${eventId} text=${text}`);

  if (!chatId || !text) {
    return { code: 200, payload: { success: true } };
  }
  if (messageId && dedupOnce(`message:${messageId}`, EVENT_DEDUP_TTL_MS)) {
    console.log(`[feishu] skip duplicate message chat=${chatId} message_id=${messageId} event_id=${eventId}`);
    return { code: 200, payload: { success: true, duplicate: true } };
  }
  if (eventId && dedupOnce(`event:${eventId}`, EVENT_DEDUP_TTL_MS)) {
    console.log(`[feishu] skip duplicate event chat=${chatId} message_id=${messageId} event_id=${eventId}`);
    return { code: 200, payload: { success: true, duplicate: true } };
  }

  const typingState = await addTypingReaction(messageId);
  try {
    const navHandled = await navigationHandlers.handleNavigationCommand(chatId, text);
    if (navHandled) {
      return { code: 200, payload: { success: true, navigation: true } };
    }

    const handleOcCommand = createOcCommandHandler({
      sendText,
      showModelCard,
      showToolCard,
      getNavigationCwd: navigationHandlers.getNavigationCwd,
      bindWorkspace: bind
    });
    const handled = await handleOcCommand(chatId, text);
    if (!handled) {
      if (!getBinding(chatId)) {
        await sendText(chatId, "❌ 未绑定工作区，请先发送：/oc bind <repoPath> [branch]");
        return { code: 200, payload: { success: true, needBind: true } };
      }
      const model = getThreadModel(chatId);
      const tool = getThreadTool(chatId) || getDefaultRuntimeProviderId();
      await run(chatId, text, model, tool);
    }
  } finally {
    await removeTypingReaction(typingState);
  }
  return { code: 200, payload: { success: true } };
}

async function processCardEvent(normalized, event, header, bind, abortRun) {
  console.log(`[feishu] card action payload=${JSON.stringify(normalized).slice(0, 2000)}`);

  const operator = (event.operator && typeof event.operator === "object") ? event.operator : {};
  const opOpenId = String(operator.open_id || "").trim();
  const chatObj = (event.chat && typeof event.chat === "object") ? event.chat : {};
  const context = (event.context && typeof event.context === "object") ? event.context : {};
  const openChatId = String(context.open_chat_id || "").trim();
  const chatId = String(chatObj.chat_id || event.chat_id || openChatId || "").trim();
  const sourceMessageId = String(context.open_message_id || event.source_message_id || normalized.message_id || "").trim();
  const eventId = String(normalized.event_id || header.event_id || event.event_id || "").trim();
  const action = (event.action && typeof event.action === "object") ? event.action : {};
  const value = (action.value && typeof action.value === "object") ? action.value : {};

  console.log(`[feishu] card action resolved chat=${chatId} open_id=${opOpenId} source_message_id=${sourceMessageId} event_id=${eventId} action=${String(value.action || "")} value=${JSON.stringify(value).slice(0, 500)}`);

  const fp = actionFingerprint(chatId, sourceMessageId, value);
  if (fp && dedupOnce(fp, CARD_NO_EVENT_TTL_MS)) {
    console.log(`[feishu] skip duplicate card action chat=${chatId} source_message_id=${sourceMessageId} action=${String(value.action || "")}`);
    return { code: 200, payload: { success: true, duplicate: true } };
  }
  if (eventId && dedupOnce(`event:${eventId}`, EVENT_DEDUP_TTL_MS)) {
    console.log(`[feishu] skip duplicate card event chat=${chatId} source_message_id=${sourceMessageId} event_id=${eventId}`);
    return { code: 200, payload: { success: true, duplicate: true } };
  }

  if (chatId) {
    try {
      const handled = await navigationHandlers.handleNavigationAction(chatId, value, {
        bindWorkspace: bind,
        requestRunAbort: abortRun
      });
      if (!handled) {
        console.log(`[feishu] card action not handled chat=${chatId} action=${String(value.action || "")}`);
      }
    } catch (error) {
      console.error("[feishu] card action dispatch failed", error);
      await sendText(chatId, `❌ 卡片操作失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { code: 200, payload: { success: true } };
}

async function processNormalizedEvent(normalized, run, bind, abortRun, explicitEventType) {
  const header = (normalized.header && typeof normalized.header === "object") ? normalized.header : {};
  const eventType = String(explicitEventType || header.event_type || normalized.event_type || "").trim();
  const event = (normalized.event && typeof normalized.event === "object") ? normalized.event : normalized;

  markEvent(eventType || "unknown");
  console.log(`[feishu] event received type=${eventType || "unknown"}`);

  if (eventType === "im.message.receive_v1") {
    return await processMessageEvent(normalized, event, header, run, bind);
  }
  if (CARD_EVENT_TYPES.has(eventType)) {
    return await processCardEvent(normalized, event, header, bind, abortRun);
  }
  return { code: 200, payload: { success: true, ignored: true, eventType } };
}

function buildEventDispatcher(run, bind, abortRun) {
  const handleEvent = (eventType, errorLabel) => async (data) => {
    try {
      await processNormalizedEvent(data, run, bind, abortRun, eventType);
    } catch (error) {
      console.error(`[feishu] ${errorLabel} handler failed`, error);
      const alreadyNotified = Boolean(error && typeof error === "object" && error.__feishuUserNotified);
      if (eventType === "im.message.receive_v1" && !alreadyNotified) {
        const message = (data && typeof data === "object" && data.message && typeof data.message === "object") ? data.message : {};
        const chatId = String((message && message.chat_id) || "").trim();
        if (chatId) {
          await sendText(chatId, `❌ 处理消息失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    return;
  };

  return new lark.EventDispatcher({
    encryptKey: config.feishuEncryptKey || undefined
  }).register({
    "im.message.receive_v1": handleEvent("im.message.receive_v1", "long connection"),
    "card.action.trigger": handleEvent("card.action.trigger", "card.action.trigger"),
    "card.action.trigger_v1": handleEvent("card.action.trigger_v1", "card.action.trigger_v1"),
    "card.action.v1": handleEvent("card.action.v1", "card.action.v1"),
    "im.message.action_card_v1": handleEvent("im.message.action_card_v1", "im.message.action_card_v1"),
    "im.message.message_read_v1": async () => undefined,
    "im.message.reaction.created_v1": async () => undefined,
    "im.message.reaction.deleted_v1": async () => undefined,
    "im.chat.access_event.bot_p2p_chat_entered_v1": async () => undefined
  });
}

async function waitForInitialWsCheck(client) {
  const timeoutMs = Math.max(1000, Number(config.feishuWsStartupCheckTimeoutMs || 10000));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const reconnectInfo = client?.getReconnectInfo?.() || {};
    const lastConnectTime = Number(reconnectInfo.lastConnectTime || 0);
    const nextConnectTime = Number(reconnectInfo.nextConnectTime || 0);

    if (lastConnectTime > 0 && nextConnectTime === 0) {
      console.log(`[feishu] ws startup check ok last_connect=${new Date(lastConnectTime).toISOString()}`);
      return;
    }
    if (lastConnectTime > 0 && nextConnectTime > Date.now()) {
      throw new Error(`ws connect failed, next retry at ${new Date(nextConnectTime).toISOString()}`);
    }
    await sleep(250);
  }
  throw new Error(`ws startup check timeout after ${timeoutMs}ms`);
}

export async function startFeishuLongConnection(run, bind, abortRun) {
  if (wsStarted) {
    return;
  }
  if (!config.feishuAppId || !config.feishuAppSecret) {
    console.log("[feishu] skip long connection: missing app credentials");
    return;
  }
  if (config.feishuConnectionMode !== "long_connection") {
    console.log(`[feishu] skip long connection: mode=${config.feishuConnectionMode}`);
    return;
  }

  const preflight = await preflightLongConnection();
  console.log(`[feishu] ws preflight ok ws_host=${preflight.wsHost}`);

  wsClient = createWsClient();
  await wsClient.start({
    eventDispatcher: buildEventDispatcher(run, bind, abortRun)
  });
  wsStarted = true;
  console.log(`[feishu] long connection started pid=${process.pid}`);
  console.log("[feishu] ws note: events are cluster-dispatched; only one online client instance receives each event");

  await waitForInitialWsCheck(wsClient);
  startWsHealthLogLoop(wsClient);
}
