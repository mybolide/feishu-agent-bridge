import path from "node:path";
import { IFlowClient } from "@iflow-ai/iflow-cli-sdk";
import { createClientOptions } from "./client-options.js";
import { REQUEST_TIMEOUT_MS, normalizeDirectory, withTimeout } from "./common.js";
import { listSessionMetaRows } from "./session-meta-store.js";
import {
  createClientWrapper,
  ensureCleanupTimer,
  ensureConnected,
  findSessionWrapper,
  listActiveSessionWrappers,
  registerSessionWrapper,
  rememberSession,
  safeDisconnect
} from "./session-runtime.js";

export { ensureCleanupTimer } from "./session-runtime.js";
export { ensureConnected, getSessionWrapper, rememberSession, resetSessionWrapper } from "./session-runtime.js";

export async function createSession(directory, title = "") {
  const normalizedDir = normalizeDirectory(directory);
  const startedAt = Date.now();
  const client = new IFlowClient(createClientOptions(normalizedDir));
  await withTimeout(
    client.connect({ skipSession: true }),
    REQUEST_TIMEOUT_MS,
    `iFlow createSession connect directory=${normalizedDir}`
  );
  const sessionId = String(
    await withTimeout(
      client.newSession(),
      REQUEST_TIMEOUT_MS,
      `iFlow createSession newSession directory=${normalizedDir}`
    )
  ).trim();
  if (!sessionId) {
    throw new Error("iFlow newSession returned empty sessionId");
  }
  const normalizedTitle = String(title || `iflow-${path.basename(normalizedDir)}-${Date.now()}`).trim();
  const wrapper = createClientWrapper(sessionId, normalizedDir, normalizedTitle);
  wrapper.client = client;
  wrapper.connected = true;
  registerSessionWrapper(wrapper);
  rememberSession(sessionId, normalizedDir, normalizedTitle);
  console.log(
    `[trace][iflow] createSession directory=${normalizedDir} session=${sessionId} elapsedMs=${Date.now() - startedAt}`
  );
  return {
    id: sessionId,
    title: normalizedTitle,
    directory: normalizedDir
  };
}

export async function listSessions(directory) {
  const normalizedDir = normalizeDirectory(directory);
  const dbRows = listSessionMetaRows(normalizedDir);
  const output = [];
  const seen = new Set();
  for (const row of dbRows) {
    const id = String(row?.session_id || "").trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    output.push({
      id,
      title: String(row?.title || ""),
      directory: normalizedDir
    });
  }
  for (const wrapper of listActiveSessionWrappers(normalizedDir)) {
    const id = String(wrapper.sessionId || "").trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    output.push({
      id,
      title: String(wrapper.title || ""),
      directory: normalizedDir
    });
  }
  return output.slice(0, 100);
}

export async function abortSession(directory, sessionId) {
  const normalizedDir = normalizeDirectory(directory);
  const normalizedSessionId = String(sessionId || "").trim();
  if (!normalizedSessionId) {
    return;
  }
  const existing = findSessionWrapper(normalizedSessionId);
  if (existing) {
    await ensureConnected(existing);
    await withTimeout(existing.client.interrupt(), REQUEST_TIMEOUT_MS, `iFlow interrupt session=${normalizedSessionId}`);
    rememberSession(normalizedSessionId, existing.directory, existing.title);
    return;
  }
  const tempWrapper = createClientWrapper(normalizedSessionId, normalizedDir);
  try {
    await ensureConnected(tempWrapper);
    await withTimeout(
      tempWrapper.client.interrupt(),
      REQUEST_TIMEOUT_MS,
      `iFlow interrupt session=${normalizedSessionId}`
    );
  } finally {
    await safeDisconnect(tempWrapper.client);
  }
  rememberSession(normalizedSessionId, normalizedDir, "");
}
