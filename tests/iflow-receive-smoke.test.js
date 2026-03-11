import test from "node:test";
import assert from "node:assert/strict";
import { resolveRuntimeProvider } from "../gateway/agent-runtime/index.js";

function parseBoolean(raw) {
  const value = String(raw || "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(value);
}

function parsePositiveInt(raw, fallback) {
  const value = Number.parseInt(String(raw || "").trim(), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const enabled = parseBoolean(process.env.IFLOW_SMOKE);
const timeoutMs = parsePositiveInt(process.env.IFLOW_SMOKE_TIMEOUT_MS, 180000);

test("iflow smoke: send '你好' and receive non-empty response", { skip: !enabled, timeout: timeoutMs + 20000 }, async () => {
  const provider = resolveRuntimeProvider("iflow-cli");
  assert.ok(provider, "iflow-cli provider is unavailable");

  const cwd = process.cwd();
  const created = await provider.session.create(cwd, `iflow-smoke-${Date.now()}`);
  const sessionId = String(created?.id || "").trim();
  assert.ok(sessionId, "failed to create iflow session");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`iflow smoke timeout ${timeoutMs}ms`)), timeoutMs);
  const startedAt = Date.now();
  let firstProgressAt = 0;
  let progressLen = 0;

  try {
    const output = await provider.run.sendMessage(cwd, sessionId, "你好", "", {
      signal: controller.signal,
      onProgress: async (progress) => {
        const text = String(progress?.text || "");
        if (text) {
          if (!firstProgressAt) {
            firstProgressAt = Date.now();
          }
          progressLen = text.length;
        }
      }
    });

    const finalText = String(output || "").trim();
    assert.ok(finalText.length > 0 || progressLen > 0, "iflow returned empty response");
    if (firstProgressAt > 0) {
      console.log(`[iflow-smoke] firstProgressMs=${firstProgressAt - startedAt}`);
    }
    console.log(`[iflow-smoke] elapsedMs=${Date.now() - startedAt} outputLen=${finalText.length}`);
  } finally {
    clearTimeout(timer);
    await provider.session.abort(cwd, sessionId).catch(() => undefined);
  }
});
