import { IFlowClient } from "@iflow-ai/iflow-cli-sdk";
import { createClientOptions } from "./client-options.js";
import { MODEL_CACHE_TTL_MS, REQUEST_TIMEOUT_MS, parseModelId, withTimeout } from "./common.js";
import { listSessionMetaRows, resolveModelProbeDirectory, upsertSessionMeta } from "./session-meta-store.js";
import { safeDisconnect } from "./session-pool.js";

let modelCacheRows = [];
let modelCacheAt = 0;

function normalizeModelRows(rawModels) {
  const rows = Array.isArray(rawModels)
    ? rawModels
    : (Array.isArray(rawModels?.availableModels) ? rawModels.availableModels : []);
  const output = [];
  const seen = new Set();
  for (const item of rows) {
    const modelId = typeof item === "string"
      ? String(item).trim()
      : String(item?.id || "").trim();
    if (!modelId || seen.has(modelId)) {
      continue;
    }
    seen.add(modelId);
    output.push(`iflow-cli/${modelId}`);
  }
  return output;
}

function appendModelIfValid(target, seen, rawModel) {
  const modelId = parseModelId(rawModel);
  if (!modelId) {
    return;
  }
  const normalized = `iflow-cli/${modelId}`;
  if (seen.has(normalized)) {
    return;
  }
  seen.add(normalized);
  target.push(normalized);
}

export async function listModels(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && modelCacheRows.length > 0 && (now - modelCacheAt) < MODEL_CACHE_TTL_MS) {
    return [...modelCacheRows];
  }
  const probeDirectory = resolveModelProbeDirectory();

  const fetchModels = async (mode) => {
    const client = new IFlowClient(createClientOptions(probeDirectory));
    try {
      if (mode === "skip") {
        await withTimeout(
          client.connect({ skipSession: true }),
          REQUEST_TIMEOUT_MS,
          `iFlow list models connect directory=${probeDirectory} mode=skip`
        );
      } else {
        if (mode === "new") {
          await withTimeout(
            client.connect(),
            REQUEST_TIMEOUT_MS,
            `iFlow list models connect directory=${probeDirectory} mode=new`
          );
          const sessionId = String(client.getSessionId?.() || "").trim();
          if (sessionId) {
            upsertSessionMeta(sessionId, probeDirectory, "iflow-model-probe");
          }
        } else {
          const latestSessionId = String(listSessionMetaRows(probeDirectory)?.[0]?.session_id || "").trim();
          if (latestSessionId) {
            await withTimeout(
              client.connect({ skipSession: true }),
              REQUEST_TIMEOUT_MS,
              `iFlow list models connect directory=${probeDirectory} mode=load`
            );
            await withTimeout(
              client.loadSession(latestSessionId),
              REQUEST_TIMEOUT_MS,
              `iFlow list models loadSession=${latestSessionId}`
            );
          } else {
            await withTimeout(
              client.connect(),
              REQUEST_TIMEOUT_MS,
              `iFlow list models connect directory=${probeDirectory} mode=load-no-history`
            );
          }
        }
      }
      const payload = await withTimeout(client.config.get("models"), REQUEST_TIMEOUT_MS, "iFlow config.get(models)");
      const rows = normalizeModelRows(payload);
      const seen = new Set(rows);
      if (rows.length === 0) {
        const currentModel = await withTimeout(
          client.config.get("model").catch(() => ""),
          REQUEST_TIMEOUT_MS,
          "iFlow config.get(model)"
        );
        appendModelIfValid(rows, seen, currentModel);
        appendModelIfValid(rows, seen, process.env.IFLOW_MODEL_NAME || "");
      }
      return rows;
    } finally {
      await safeDisconnect(client);
    }
  };

  let rows = await fetchModels("skip");
  if (rows.length === 0) {
    console.log("[trace][iflow] listModels empty on skipSession, fallback to load/new session");
    rows = await fetchModels("load");
  }
  if (rows.length === 0) {
    console.log("[trace][iflow] listModels empty on loaded session, fallback to new session");
    rows = await fetchModels("new");
  }

  modelCacheRows = rows;
  modelCacheAt = now;
  return [...modelCacheRows];
}
