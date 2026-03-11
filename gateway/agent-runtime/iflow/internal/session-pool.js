import path from "node:path";
import { IFlowClient } from "@iflow-ai/iflow-cli-sdk";
import { createClientOptions } from "./client-options.js";
import {
  CLIENT_CLEANUP_INTERVAL_MS,
  CLIENT_IDLE_DISCONNECT_MS,
  REQUEST_TIMEOUT_MS,
  normalizeDirectory,
  withTimeout
} from "./common.js";
import { listSessionMetaRows, upsertSessionMeta } from "./session-meta-store.js";

const CLIENTS = new Map();
let cleanupTimer = null;

function createClientWrapper(sessionId, directory, title = "") {
  return {
    sessionId: String(sessionId || "").trim(),
    directory: normalizeDirectory(directory),
    title: String(title || "").trim(),
    client: new IFlowClient(createClientOptions(directory, sessionId)),
    connected: false,
    connecting: null,
    busy: false,
    lastUsedAt: Date.now()
  };
}

export async function safeDisconnect(client) {
  try {
    await client.disconnect();
  } catch {
    // ignore disconnect errors
  }
}

export async function resetSessionWrapper(sessionId, reason = "") {
  const normalizedSessionId = String(sessionId || "").trim();
  if (!normalizedSessionId) {
    return;
  }
  const existing = CLIENTS.get(normalizedSessionId);
  if (!existing) {
    return;
  }
  existing.busy = false;
  existing.connected = false;
  existing.connecting = null;
  await safeDisconnect(existing.client);
  CLIENTS.delete(normalizedSessionId);
  if (reason) {
    console.warn(`[trace][iflow] resetSessionWrapper session=${normalizedSessionId} reason=${reason}`);
  } else {
    console.warn(`[trace][iflow] resetSessionWrapper session=${normalizedSessionId}`);
  }
}

export async function ensureConnected(wrapper, requestOptions = {}) {
  if (wrapper.connected) {
    return;
  }
  if (wrapper.connecting) {
    await wrapper.connecting;
    return;
  }
  wrapper.connecting = (async () => {
    await withTimeout(
      wrapper.client.connect({ skipSession: true }),
      REQUEST_TIMEOUT_MS,
      `iFlow connect session=${wrapper.sessionId}`,
      requestOptions
    );
    await withTimeout(
      wrapper.client.loadSession(wrapper.sessionId),
      REQUEST_TIMEOUT_MS,
      `iFlow loadSession session=${wrapper.sessionId}`,
      requestOptions
    );
    wrapper.connected = true;
  })().finally(() => {
    wrapper.connecting = null;
  });
  await wrapper.connecting;
}

export function getSessionWrapper(sessionId, directory) {
  const key = String(sessionId || "").trim();
  const dir = normalizeDirectory(directory);
  if (!key || !dir) {
    return null;
  }
  const existing = CLIENTS.get(key);
  if (existing) {
    if (normalizeDirectory(existing.directory) !== dir) {
      throw new Error(`iFlow session directory mismatch session=${key}`);
    }
    return existing;
  }
  const next = createClientWrapper(key, dir);
  CLIENTS.set(key, next);
  return next;
}

export function rememberSession(sessionId, directory, title = "") {
  upsertSessionMeta(sessionId, directory, title);
  const wrapper = CLIENTS.get(sessionId);
  if (wrapper) {
    wrapper.lastUsedAt = Date.now();
    if (title) {
      wrapper.title = title;
    }
  }
}

export function ensureCleanupTimer() {
  if (cleanupTimer) {
    return;
  }
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [sessionId, wrapper] of CLIENTS.entries()) {
      if (wrapper.busy) {
        continue;
      }
      if ((now - Number(wrapper.lastUsedAt || 0)) < CLIENT_IDLE_DISCONNECT_MS) {
        continue;
      }
      safeDisconnect(wrapper.client).catch(() => undefined);
      CLIENTS.delete(sessionId);
    }
  }, CLIENT_CLEANUP_INTERVAL_MS);
  if (typeof cleanupTimer.unref === "function") {
    cleanupTimer.unref();
  }
}

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
  CLIENTS.set(sessionId, wrapper);
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
  for (const wrapper of CLIENTS.values()) {
    if (normalizeDirectory(wrapper.directory) !== normalizedDir) {
      continue;
    }
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
  const existing = CLIENTS.get(normalizedSessionId);
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
