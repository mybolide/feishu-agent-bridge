import * as lark from "@larksuiteoapi/node-sdk";
import fs from "node:fs";
import path from "node:path";
import { config } from "../../config/index.js";

const TYPING_EMOJI = "Typing";
const WS_CONFIG_REQUEST_TIMEOUT_MS = 15000;

const domain = config.feishuDomain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu;
const domainBaseUrl = config.feishuDomain === "lark"
  ? "https://open.larksuite.com"
  : "https://open.feishu.cn";

function resolveWsLoggerLevel() {
  const value = String(config.feishuLogLevel || "info").trim().toLowerCase();
  if (value === "debug") {
    return lark.LoggerLevel.debug;
  }
  if (value === "warn") {
    return lark.LoggerLevel.warn;
  }
  if (value === "error") {
    return lark.LoggerLevel.error;
  }
  return lark.LoggerLevel.info;
}

function createFeishuHttpInstance() {
  const instance = lark.defaultHttpInstance;
  if (config.feishuHttpDisableProxy && instance?.defaults) {
    instance.defaults.proxy = false;
  }
  return instance;
}

const feishuHttpInstance = createFeishuHttpInstance();

export const client = new lark.Client({
  appId: config.feishuAppId,
  appSecret: config.feishuAppSecret,
  appType: lark.AppType.SelfBuild,
  domain,
  httpInstance: feishuHttpInstance
});

function normalizeFeishuTarget(target) {
  return String(target || "")
    .trim()
    .replace(/^(feishu|lark):/i, "")
    .replace(/^(chat|group|user|dm|open_id):/i, "");
}

function resolveReceiveIdType(target) {
  const raw = String(target || "").trim().replace(/^(feishu|lark):/i, "");
  if (/^(chat|group):/i.test(raw)) {
    return "chat_id";
  }
  if (/^(user|open_id):/i.test(raw)) {
    return "open_id";
  }
  if (/^oc_/i.test(raw)) {
    return "chat_id";
  }
  if (/^ou_/i.test(raw)) {
    return "open_id";
  }
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) {
    return "email";
  }
  return "chat_id";
}

function resolveFeishuSendTarget(target) {
  const raw = String(target || "").trim();
  const receiveId = normalizeFeishuTarget(raw);
  if (!receiveId) {
    throw new Error(`Invalid Feishu target: ${raw}`);
  }
  return {
    receiveId,
    receiveIdType: resolveReceiveIdType(raw)
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms || 0)));
}

async function sdkSendMessage(chatId, msgType, content) {
  const { receiveId, receiveIdType } = resolveFeishuSendTarget(chatId);
  const startedAt = Date.now();
  console.log(`[feishu] send ${msgType} -> ${receiveIdType}:${receiveId}: ${String(content).slice(0, 300)}`);
  try {
    const response = await client.im.message.create({
      params: {
        receive_id_type: receiveIdType
      },
      data: {
        receive_id: receiveId,
        msg_type: msgType,
        content
      }
    });
    console.log(`[trace][feishu] send ${msgType} ok receive_id_type=${receiveIdType} elapsedMs=${Date.now() - startedAt}`);
    return response;
  } catch (error) {
    console.error(`[trace][feishu] send ${msgType} failed receive_id_type=${receiveIdType} elapsedMs=${Date.now() - startedAt}`, error);
    throw error;
  }
}

export async function sendText(chatId, text) {
  return await sdkSendMessage(chatId, "text", JSON.stringify({ text }));
}

export async function sendCard(chatId, card) {
  return await sdkSendMessage(chatId, "interactive", JSON.stringify(card));
}

export async function deleteMessage(messageId) {
  if (!messageId) {
    throw new Error("messageId is required");
  }
  await client.im.message.delete({
    path: { message_id: messageId }
  });
  console.log(`[feishu] deleted messageId=${messageId}`);
}

export async function updateCard(messageId, card) {
  if (!messageId) {
    throw new Error("messageId is required");
  }
  const startedAt = Date.now();
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await client.im.message.patch({
        path: { message_id: messageId },
        data: {
          content: JSON.stringify(card),
          msg_type: "interactive"
        }
      });
      console.log(`[trace][feishu] update card ok messageId=${messageId} attempt=${attempt + 1} elapsedMs=${Date.now() - startedAt}`);
      return response;
    } catch (error) {
      lastError = error;
      console.warn(`[trace][feishu] update card retry messageId=${messageId} attempt=${attempt + 1} elapsedMs=${Date.now() - startedAt}`);
      if (attempt >= 2) {
        break;
      }
      await sleep(200 * (attempt + 1));
    }
  }
  console.error(`[trace][feishu] update card failed messageId=${messageId} elapsedMs=${Date.now() - startedAt}`);
  throw lastError instanceof Error ? lastError : new Error(String(lastError || "update card failed"));
}

export async function dispatchInteractiveCard(chatId, card, options = {}) {
  const messageId = String(options?.messageId || "").trim();
  const allowFallbackSend = options?.allowFallbackSend !== false;
  if (messageId) {
    try {
      await updateCard(messageId, card);
      console.log(`[feishu] dispatch interactive updated messageId=${messageId}`);
      return { mode: "updated", messageId };
    } catch (error) {
      console.error(`[feishu] update card failed messageId=${messageId}`, error);
      if (!allowFallbackSend) {
        throw error;
      }
    }
  }
  const resp = await sendCard(chatId, card);
  const nextMessageId = String(resp?.data?.message_id || resp?.message_id || "").trim();
  console.log(`[feishu] dispatch interactive sent messageId=${nextMessageId || ""}`);
  return { mode: "sent", messageId: nextMessageId };
}

export async function addTypingReaction(messageId) {
  const value = String(messageId || "").trim();
  if (!value) {
    return null;
  }
  try {
    const resp = await client.im.messageReaction.create({
      path: { message_id: value },
      data: {
        reaction_type: {
          emoji_type: TYPING_EMOJI
        }
      }
    });
    const reactionId = String(resp?.data?.reaction_id || resp?.reaction_id || "").trim();
    console.log(`[feishu] add typing reaction messageId=${value} reactionId=${reactionId}`);
    return reactionId ? { messageId: value, reactionId } : { messageId: value, reactionId: "" };
  } catch (error) {
    console.warn(`[feishu] add typing reaction failed messageId=${value}`, error);
    return { messageId: value, reactionId: "" };
  }
}

export async function removeTypingReaction(state) {
  const messageId = String(state?.messageId || "").trim();
  const reactionId = String(state?.reactionId || "").trim();
  if (!messageId || !reactionId) {
    return;
  }
  try {
    await client.im.messageReaction.delete({
      path: {
        message_id: messageId,
        reaction_id: reactionId
      }
    });
    console.log(`[feishu] remove typing reaction messageId=${messageId} reactionId=${reactionId}`);
  } catch (error) {
    console.warn(`[feishu] remove typing reaction failed messageId=${messageId} reactionId=${reactionId}`, error);
  }
}

export async function sendFileFromFile(chatId, filePath) {
  const { receiveId, receiveIdType } = resolveFeishuSendTarget(chatId);
  const file = fs.readFileSync(filePath);
  const name = path.basename(filePath);
  const uploaded = await client.im.file.create({
    data: {
      file_type: "stream",
      file_name: name,
      file
    }
  });
  const fileKey = String(uploaded?.data?.file_key || uploaded?.file_key || "").trim();
  if (!fileKey) {
    throw new Error(`upload file failed: ${filePath}`);
  }
  await client.im.message.create({
    params: { receive_id_type: receiveIdType },
    data: {
      receive_id: receiveId,
      msg_type: "file",
      content: JSON.stringify({ file_key: fileKey })
    }
  });
}

function resolvePreflightError(error) {
  const rawMessage = String(error?.message || error || "").trim();
  const status = Number(error?.response?.status || 0);
  const responseBody = String(error?.response?.data || "").trim();
  const text = `${rawMessage} ${responseBody}`.trim().toLowerCase();
  if (status === 400 && text.includes("plain http request was sent to https port")) {
    return `${rawMessage}; possible proxy mismatch, set FEISHU_HTTP_DISABLE_PROXY=true`;
  }
  return rawMessage || "unknown error";
}

export async function preflightLongConnection() {
  try {
    const payload = await feishuHttpInstance.request({
      method: "post",
      url: `${domainBaseUrl}/callback/ws/endpoint`,
      data: {
        AppID: config.feishuAppId,
        AppSecret: config.feishuAppSecret
      },
      headers: {
        locale: "zh"
      },
      timeout: WS_CONFIG_REQUEST_TIMEOUT_MS
    });

    const code = Number(payload?.code ?? -1);
    if (code !== 0) {
      throw new Error(`code=${code} msg=${String(payload?.msg || "")}`);
    }

    const wsUrl = String(payload?.data?.URL || "").trim();
    if (!/^wss:\/\//i.test(wsUrl)) {
      throw new Error("ws endpoint response missing wss URL");
    }

    let wsHost = "";
    try {
      wsHost = new URL(wsUrl).host;
    } catch {
      wsHost = "";
    }

    return {
      wsHost: wsHost || "(unknown)",
      wsUrl,
      clientConfig: payload?.data?.ClientConfig || {}
    };
  } catch (error) {
    throw new Error(`long-connection preflight failed: ${resolvePreflightError(error)}`);
  }
}

export function createWsClient() {
  return new lark.WSClient({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
    appType: lark.AppType.SelfBuild,
    domain,
    loggerLevel: resolveWsLoggerLevel(),
    httpInstance: feishuHttpInstance
  });
}
