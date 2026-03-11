import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

function collectActionLabels(card) {
  const labels = [];
  const elements = Array.isArray(card?.elements) ? card.elements : [];
  for (const element of elements) {
    if (element?.tag !== "action" || !Array.isArray(element.actions)) {
      continue;
    }
    for (const action of element.actions) {
      labels.push(String(action?.text?.content || "").trim());
    }
  }
  return labels.filter(Boolean);
}

async function withTempDb(run) {
  const dbFile = path.join(
    os.tmpdir(),
    `opencode-bridge-nav-controls-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
  );
  const previousDbPath = process.env.DB_PATH;
  process.env.DB_PATH = dbFile;
  try {
    await run();
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
}

test("navigation card should show bind button when workspace is unbound", async () => {
  await withTempDb(async () => {
    const stamp = Date.now();
    const navUrl = pathToFileURL(path.resolve("gateway/feishu/ui/navigation.js")).href;
    const storeUrl = pathToFileURL(path.resolve("gateway/state/store.js")).href;
    const { createNavigationHandlers } = await import(`${navUrl}?case=nav-unbound-${stamp}`);
    const store = await import(`${storeUrl}?case=nav-unbound-${stamp}`);

    const cards = [];
    const handlers = createNavigationHandlers({
      sendText: async () => {},
      sendCard: async (_chatId, card) => {
        cards.push(card);
      },
      sendFileFromFile: async () => {},
      showModelCard: async () => {},
      showToolCard: async () => {},
      bindWorkspace: async () => {},
      requestRunAbort: () => {}
    });

    const threadId = `thread-unbound-${stamp}`;
    store.clearBinding(threadId);
    await handlers.sendDirectoryCard(threadId, path.resolve("."), {
      showFolders: false,
      showFiles: false
    });

    const labels = collectActionLabels(cards.at(-1));
    assert.ok(labels.includes("绑定工作空间"));
    assert.ok(!labels.includes("解绑工作空间"));
  });
});

test("navigation card should show unbind button when workspace is bound", async () => {
  await withTempDb(async () => {
    const stamp = Date.now();
    const navUrl = pathToFileURL(path.resolve("gateway/feishu/ui/navigation.js")).href;
    const storeUrl = pathToFileURL(path.resolve("gateway/state/store.js")).href;
    const { createNavigationHandlers } = await import(`${navUrl}?case=nav-bound-${stamp}`);
    const store = await import(`${storeUrl}?case=nav-bound-${stamp}`);

    const cards = [];
    const handlers = createNavigationHandlers({
      sendText: async () => {},
      sendCard: async (_chatId, card) => {
        cards.push(card);
      },
      sendFileFromFile: async () => {},
      showModelCard: async () => {},
      showToolCard: async () => {},
      bindWorkspace: async () => {},
      requestRunAbort: () => {}
    });

    const threadId = `thread-bound-${stamp}`;
    const workspace = path.resolve(".");
    store.upsertBinding(threadId, workspace, "main");
    await handlers.sendDirectoryCard(threadId, workspace, {
      showFolders: false,
      showFiles: false
    });

    const labels = collectActionLabels(cards.at(-1));
    assert.ok(labels.includes("解绑工作空间"));
  });
});
