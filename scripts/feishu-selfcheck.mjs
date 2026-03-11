import * as lark from "@larksuiteoapi/node-sdk";
import { config } from "../gateway/config/index.js";
import { createWsClient, preflightLongConnection, sendText } from "../gateway/feishu/sdk/messenger.js";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = String(argv[i] || "").trim();
    const value = String(argv[i + 1] || "").trim();
    if (!key.startsWith("--")) {
      continue;
    }
    if (value && !value.startsWith("--")) {
      out[key] = value;
      i += 1;
    } else {
      out[key] = "1";
    }
  }
  return out;
}

function parsePositiveInt(raw, fallback) {
  const n = Number.parseInt(String(raw || "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseText(content) {
  const raw = String(content || "").trim();
  if (!raw) {
    return "";
  }
  try {
    const parsed = JSON.parse(raw);
    return String(parsed?.text || "").trim();
  } catch {
    return raw;
  }
}

async function waitForInbound(waitMs) {
  const timeoutMs = parsePositiveInt(waitMs, 30000);
  const ws = createWsClient();
  let hit = null;
  let settled = false;
  let stopPromise = Promise.resolve();
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      reject(new Error(`inbound wait timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    const close = async (result, error = null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        if (typeof ws.stop === "function") {
          stopPromise = Promise.resolve(ws.stop());
          await stopPromise;
        }
      } catch {
        // ignore
      }
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    };

    const eventDispatcher = new lark.EventDispatcher({
      encryptKey: config.feishuEncryptKey || undefined
    }).register({
      "im.message.receive_v1": async (data) => {
        const message = (data && typeof data === "object" && data.message && typeof data.message === "object")
          ? data.message
          : {};
        const chatId = String(message.chat_id || "").trim();
        const messageId = String(message.message_id || "").trim();
        const text = parseText(message.content);
        hit = { chatId, messageId, text };
        await close(hit);
      },
      "card.action.trigger": async () => undefined,
      "card.action.trigger_v1": async () => undefined,
      "card.action.v1": async () => undefined,
      "im.message.action_card_v1": async () => undefined
    });

    ws.start({ eventDispatcher })
      .then(() => undefined)
      .catch(async (error) => {
        await close(null, error instanceof Error ? error : new Error(String(error || "ws start failed")));
      });
  });

  const result = await done;
  await stopPromise.catch(() => undefined);
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const chatId = String(args["--chat"] || process.env.FEISHU_SELFCHECK_CHAT_ID || "").trim();
  const waitInboundMs = parsePositiveInt(
    args["--wait-inbound-ms"] || process.env.FEISHU_SELFCHECK_WAIT_MS || "",
    0
  );

  if (!config.feishuAppId || !config.feishuAppSecret) {
    throw new Error("missing FEISHU_APP_ID or FEISHU_APP_SECRET");
  }

  const preflight = await preflightLongConnection();
  console.log(`[selfcheck] preflight ok ws_host=${preflight.wsHost}`);
  console.log(`[selfcheck] connection_mode=${config.feishuConnectionMode} encrypt_key=${config.feishuEncryptKey ? "set" : "empty"}`);

  if (chatId) {
    await sendText(chatId, "[self-check] gateway outbound check ok");
    console.log(`[selfcheck] outbound send ok chat=${chatId}`);
  } else {
    console.log("[selfcheck] outbound send skipped (set --chat or FEISHU_SELFCHECK_CHAT_ID)");
  }

  if (waitInboundMs > 0) {
    console.log("[selfcheck] note: stop other long-connection clients first, otherwise events may be routed to another client");
    console.log(`[selfcheck] waiting inbound event for ${waitInboundMs}ms ...`);
    const inbound = await waitForInbound(waitInboundMs);
    console.log(`[selfcheck] inbound ok chat=${inbound.chatId} message_id=${inbound.messageId} text=${JSON.stringify(inbound.text)}`);
  } else {
    console.log("[selfcheck] inbound wait skipped (set --wait-inbound-ms or FEISHU_SELFCHECK_WAIT_MS)");
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[selfcheck] failed: ${message}`);
  process.exitCode = 1;
});
