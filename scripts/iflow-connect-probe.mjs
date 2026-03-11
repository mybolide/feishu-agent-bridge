import fs from "node:fs";
import { getSessionWrapper, ensureConnected } from "../gateway/agent-runtime/iflow/internal/session-pool.js";

const sessionId = String(process.argv[2] || "").trim();
const hardExitMs = Number.parseInt(String(process.argv[3] || "60000"), 10) || 60000;
const logFile = String(process.argv[4] || "logs/iflow-connect-probe.log").trim();

if (!sessionId) {
  console.error("usage: node scripts/iflow-connect-probe.mjs <sessionId> [hardExitMs] [logFile]");
  process.exit(2);
}

function log(message) {
  fs.appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`);
}

if (fs.existsSync(logFile)) {
  fs.rmSync(logFile, { force: true });
}

log(`start sid=${sessionId}`);
setTimeout(() => {
  log(`hard-exit after ${hardExitMs}ms`);
  process.exit(124);
}, Math.max(5000, hardExitMs));

(async () => {
  try {
    const wrapper = getSessionWrapper(sessionId, process.cwd());
    log("wrapper-created");
    const startedAt = Date.now();
    await ensureConnected(wrapper);
    log(`ensureConnected-ok ms=${Date.now() - startedAt}`);
    process.exit(0);
  } catch (error) {
    log(`ensureConnected-fail ${(error && error.message) ? error.message : String(error)}`);
    process.exit(1);
  }
})();
