import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

test("workspace unbind should not be auto-restored by thread_path", async () => {
  const dbFile = path.join(
    os.tmpdir(),
    `opencode-bridge-workspace-unbind-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
  );
  const previousDbPath = process.env.DB_PATH;
  process.env.DB_PATH = dbFile;

  const storeUrl = pathToFileURL(path.resolve("gateway/state/store.js")).href;
  const store = await import(`${storeUrl}?case=workspace-unbind-${Date.now()}`);

  const threadId = `thread-${Date.now()}`;
  const repoPath = path.resolve("gateway");
  const outsidePath = path.resolve("docs");

  try {
    store.upsertBinding(threadId, repoPath, "main");
    assert.equal(store.getBinding(threadId)?.repoPath, repoPath);

    store.clearBinding(threadId);
    assert.equal(store.getBinding(threadId), null);

    store.setThreadPath(threadId, outsidePath);
    assert.equal(store.getBinding(threadId), null);
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
