import fs from "node:fs";
import { sendMessageToSession } from "../gateway/agent-runtime/iflow/internal/message-service.js";
import { getSessionWrapper, ensureConnected } from "../gateway/agent-runtime/iflow/internal/session-pool.js";

const sessionId = String(process.argv[2] || "").trim();
const text = String(process.argv[3] || "你好").trim();
const hardExitMs = Number.parseInt(String(process.argv[4] || "180000"), 10) || 180000;
const logFile = String(process.argv[5] || "logs/iflow-message-probe.log").trim();

if (!sessionId) {
  console.error("usage: node scripts/iflow-message-probe.mjs <sessionId> [text] [hardExitMs] [logFile]");
  process.exit(2);
}

function log(message) {
  fs.appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`);
}

if (fs.existsSync(logFile)) {
  fs.rmSync(logFile, { force: true });
}

log(`start sid=${sessionId} text=${JSON.stringify(text)}`);
const startAt = Date.now();
const controller = new AbortController();
setTimeout(() => {
  controller.abort(new Error(`probe hard timeout ${hardExitMs}ms`));
  log(`abort-signal at ${hardExitMs}ms`);
}, Math.max(5000, hardExitMs));
setTimeout(() => {
  log(`hard-exit at ${hardExitMs + 30000}ms`);
  process.exit(124);
}, Math.max(10000, hardExitMs + 30000));

(async () => {
  try {
    const wrapper = getSessionWrapper(sessionId, process.cwd());
    log("wrapper-created");
    const connectAt = Date.now();
    await ensureConnected(wrapper, { signal: controller.signal });
    log(`ensureConnected-ok ms=${Date.now() - connectAt}`);

    let firstProgressAt = 0;
    const output = await sendMessageToSession(process.cwd(), sessionId, text, "", {
      signal: controller.signal,
      onProgress: async (progress) => {
        const nextText = String(progress?.text || "");
        if (!firstProgressAt && nextText) {
          firstProgressAt = Date.now();
          log(`first-progress ms=${firstProgressAt - startAt} len=${nextText.length}`);
        }
      }
    });
    log(`done totalMs=${Date.now() - startAt} outLen=${String(output || "").length}`);
    process.exit(0);
  } catch (error) {
    log(`failed totalMs=${Date.now() - startAt} err=${(error && error.message) ? error.message : String(error)}`);
    process.exit(1);
  }
})();
