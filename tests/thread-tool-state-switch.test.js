import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

test("switchThreadTool should restore model/session by tool", async () => {
  const dbFile = path.join(
    os.tmpdir(),
    `opencode-bridge-thread-tool-switch-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
  );
  const previousDbPath = process.env.DB_PATH;
  process.env.DB_PATH = dbFile;

  const storeUrl = pathToFileURL(path.resolve("gateway/state/store.js")).href;
  const store = await import(`${storeUrl}?case=thread-tool-switch-${Date.now()}`);
  const threadId = `thread-switch-${Date.now()}`;

  try {
    store.setThreadTool(threadId, "opencode");
    store.setThreadModel(threadId, "code3/gpt-5.3-codex");
    store.setThreadSession(threadId, "ses-opencode-1");

    const toIFlow = store.switchThreadTool(threadId, "iflow-cli");
    assert.equal(toIFlow.toolId, "iflow-cli");
    assert.equal(toIFlow.model, "");
    assert.equal(toIFlow.sessionId, "");
    assert.equal(store.getThreadModel(threadId), "");
    assert.equal(store.getThreadSession(threadId), "");

    store.setThreadModel(threadId, "iflow-cli/glm-4.6");
    store.setThreadSession(threadId, "ses-iflow-1");

    const backToOpenCode = store.switchThreadTool(threadId, "opencode");
    assert.equal(backToOpenCode.toolId, "opencode");
    assert.equal(backToOpenCode.model, "code3/gpt-5.3-codex");
    assert.equal(backToOpenCode.sessionId, "ses-opencode-1");
    assert.equal(store.getThreadModel(threadId), "code3/gpt-5.3-codex");
    assert.equal(store.getThreadSession(threadId), "ses-opencode-1");

    const backToIFlow = store.switchThreadTool(threadId, "iflow-cli");
    assert.equal(backToIFlow.toolId, "iflow-cli");
    assert.equal(backToIFlow.model, "iflow-cli/glm-4.6");
    assert.equal(backToIFlow.sessionId, "ses-iflow-1");
  } finally {
    if (previousDbPath === undefined) {
      delete process.env.DB_PATH;
    } else {
      process.env.DB_PATH = previousDbPath;
    }
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        fs.rmSync(`${dbFile}${suffix}`, { force: true });
      } catch {
        // ignore temp cleanup failures on Windows file lock
      }
    }
  }
});
