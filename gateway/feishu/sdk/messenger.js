import * as lark from "@larksuiteoapi/node-sdk";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../../config/index.js";

const TYPING_EMOJI = "Typing";
const WS_CONFIG_REQUEST_TIMEOUT_MS = 15000;
const FEISHU_IM_FILE_MAX_BYTES = 30 * 1024 * 1024;
const FEISHU_PARSE_ERROR_TEXT = "error when parsing request";

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

function stringifyFeishuResponseData(data) {
  if (data === null || data === undefined) {
    return "";
  }
  if (typeof data === "string") {
    return data.trim();
  }
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

export function describeFeishuApiError(error) {
  const status = Number(error?.response?.status || 0);
  const responseBody = stringifyFeishuResponseData(error?.response?.data);
  const rawMessage = String(error?.message || error || "").trim();
  const details = [];
  if (status > 0) {
    details.push(`status=${status}`);
  }
  if (responseBody) {
    details.push(`body=${responseBody}`);
  }
  if (rawMessage) {
    details.push(`message=${rawMessage}`);
  }
  return details.join(" ");
}

export function isFeishuRequestParseError(error) {
  const status = Number(error?.response?.status || 0);
  const responseBody = stringifyFeishuResponseData(error?.response?.data).toLowerCase();
  return status === 400 && responseBody.includes(FEISHU_PARSE_ERROR_TEXT);
}

function escapePowerShellLiteral(value) {
  return String(value || "").replace(/'/g, "''");
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const detail = [stdout.trim(), stderr.trim()].filter(Boolean).join(" ").trim();
      reject(new Error(detail || `${command} exited with code ${code}`));
    });
  });
}

async function createZipUploadFallback(filePath) {
  if (process.platform !== "win32") {
    throw new Error("zip fallback is only supported on Windows hosts");
  }
  const originalPath = path.resolve(filePath);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-upload-"));
  const archivePath = path.join(tempDir, `${path.basename(originalPath)}.zip`);
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `Compress-Archive -LiteralPath '${escapePowerShellLiteral(originalPath)}' -DestinationPath '${escapePowerShellLiteral(archivePath)}' -CompressionLevel Optimal -Force`
  ].join("; ");
  await runCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
  const stat = fs.statSync(archivePath);
  if (stat.size > FEISHU_IM_FILE_MAX_BYTES) {
    throw new Error(`zip fallback exceeds Feishu 30MB upload limit (${stat.size} bytes)`);
  }
  return {
    archivePath,
    uploadName: path.basename(archivePath),
    cleanup() {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  };
}

async function uploadFeishuFile(filePath, uploadName = path.basename(filePath)) {
  const file = fs.readFileSync(filePath);
  const uploaded = await client.im.file.create({
    data: {
      file_type: "stream",
      file_name: uploadName,
      file
    }
  });
  const fileKey = String(uploaded?.data?.file_key || uploaded?.file_key || "").trim();
  if (!fileKey) {
    throw new Error(`upload file failed: ${uploadName}`);
  }
  return {
    fileKey,
    uploadName
  };
}

async function sendFeishuFileMessage(receiveId, receiveIdType, fileKey) {
  await client.im.message.create({
    params: { receive_id_type: receiveIdType },
    data: {
      receive_id: receiveId,
      msg_type: "file",
      content: JSON.stringify({ file_key: fileKey })
    }
  });
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

export async function sendFileFromFile(chatId, filePath, options = {}) {
  const { receiveId, receiveIdType } = resolveFeishuSendTarget(chatId);
  const uploadFile = typeof options?.uploadFile === "function" ? options.uploadFile : uploadFeishuFile;
  const sendMessage = typeof options?.sendMessage === "function"
    ? options.sendMessage
    : async ({ receiveId: targetId, receiveIdType: targetType, fileKey }) => {
      await sendFeishuFileMessage(targetId, targetType, fileKey);
    };
  const createZipFallback = typeof options?.createZipFallback === "function"
    ? options.createZipFallback
    : createZipUploadFallback;
  const originalPath = path.resolve(filePath);
  const originalName = path.basename(originalPath);
  let cleanupFallback = null;
  const deliverUpload = async (uploadPath, uploadName) => {
    const uploaded = await uploadFile(uploadPath, uploadName);
    const fileKey = String(uploaded?.fileKey || "").trim();
    if (!fileKey) {
      throw new Error(`upload file failed: ${uploadName}`);
    }
    return {
      fileKey,
      uploadName
    };
  };
  let delivered = null;

  try {
    delivered = await deliverUpload(originalPath, originalName);
  } catch (error) {
    if (!isFeishuRequestParseError(error)) {
      throw new Error(`upload file failed: ${originalName} (${describeFeishuApiError(error)})`);
    }

    console.warn(`[feishu] upload parse error for ${originalPath}, retrying with zip fallback`);
    let fallback = null;
    try {
      fallback = await createZipFallback(originalPath);
      cleanupFallback = typeof fallback?.cleanup === "function" ? fallback.cleanup : null;
      const fallbackPath = path.resolve(fallback?.archivePath || "");
      const fallbackName = String(fallback?.uploadName || path.basename(fallbackPath)).trim();
      if (!fallbackPath || !fallbackName) {
        throw new Error("zip fallback did not return a valid archive path");
      }
      delivered = await deliverUpload(fallbackPath, fallbackName);
      delivered.fallbackUsed = true;
    } catch (fallbackError) {
      throw new Error(
        `upload file failed: ${originalName} (${describeFeishuApiError(error)}); zip fallback failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`
      );
    } finally {
      if (cleanupFallback) {
        try {
          cleanupFallback();
        } catch {
          // ignore temp cleanup failures
        }
      }
    }
  }

  try {
    await sendMessage({ receiveId, receiveIdType, fileKey: delivered.fileKey });
  } catch (error) {
    throw new Error(`send file message failed: ${delivered.uploadName} (${describeFeishuApiError(error)})`);
  }

  return {
    fileKey: delivered.fileKey,
    uploadName: delivered.uploadName,
    originalPath,
    fallbackUsed: delivered.fallbackUsed === true
  };
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
