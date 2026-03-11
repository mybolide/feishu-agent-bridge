import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { config } from "../../config/index.js";
const CACHE_TTL_MS = 30_000;
const DEFAULT_MODEL_LIST_TIMEOUT_MS = 15_000;
let cacheRows = [];
let cacheAt = 0;
function safeInt(raw, fallback) {
    const value = Number.parseInt(String(raw || "").trim(), 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}
const MODEL_LIST_TIMEOUT_MS = safeInt(process.env.OPENCODE_MODEL_LIST_TIMEOUT_MS, DEFAULT_MODEL_LIST_TIMEOUT_MS);
function dedupe(rows) {
    const out = [];
    const seen = new Set();
    for (const item of rows) {
        const value = String(item || "").trim();
        if (!value || seen.has(value)) {
            continue;
        }
        seen.add(value);
        out.push(value);
    }
    return out;
}
function getServerAuthHeader() {
    const username = String(process.env.OPENCODE_SERVER_USERNAME || "opencode").trim() || "opencode";
    const password = String(process.env.OPENCODE_SERVER_PASSWORD || "").trim();
    if (!password) {
        return "";
    }
    const token = Buffer.from(`${username}:${password}`, "utf-8").toString("base64");
    return `Basic ${token}`;
}
function withTimeout(promise, timeoutMs, label) {
    const ms = Math.max(1000, Number(timeoutMs || 0) || DEFAULT_MODEL_LIST_TIMEOUT_MS);
    let timer = null;
    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
            reject(new Error(`${label} timeout after ${ms}ms`));
        }, ms);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => {
        if (timer) {
            clearTimeout(timer);
        }
    });
}
function extractProviderModels(rows) {
    const output = [];
    const providers = Array.isArray(rows) ? rows : [];
    for (const provider of providers) {
        if (!provider || typeof provider !== "object") {
            continue;
        }
        const providerId = String(provider.id || "").trim();
        if (!providerId) {
            continue;
        }
        const models = provider.models;
        if (!models || typeof models !== "object") {
            continue;
        }
        for (const [modelKey, modelValue] of Object.entries(models)) {
            const typed = modelValue && typeof modelValue === "object" ? modelValue : {};
            const modelId = String(typed.id || modelKey || "").trim();
            if (!modelId) {
                continue;
            }
            output.push(`${providerId}/${modelId}`);
        }
    }
    return output;
}
async function listModelsViaSdk() {
    const authHeader = getServerAuthHeader();
    const client = createOpencodeClient({
        baseUrl: config.opencodeServerUrl,
        responseStyle: "data",
        throwOnError: true,
        ...(authHeader ? { headers: { Authorization: authHeader } } : {})
    });
    const startedAt = Date.now();
    const payload = await withTimeout(client.provider.list(), MODEL_LIST_TIMEOUT_MS, "OpenCode provider.list");
    const allRows = payload && typeof payload === "object" ? payload.all : [];
    const connectedRows = payload && typeof payload === "object" ? payload.connected : [];
    const models = dedupe([
        ...extractProviderModels(allRows),
        ...extractProviderModels(connectedRows)
    ]);
    console.log(`[trace][model] listAvailableModels sdk-hit count=${models.length} elapsedMs=${Date.now() - startedAt}`);
    return models;
}
export async function listAvailableModels(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && cacheRows.length > 0 && now - cacheAt < CACHE_TTL_MS) {
        return [...cacheRows];
    }
    try {
        const rows = await listModelsViaSdk();
        cacheRows = rows;
        cacheAt = now;
        return [...cacheRows];
    }
    catch (error) {
        console.warn(`[trace][model] listAvailableModels sdk-error message=${error instanceof Error ? error.message : String(error)}`);
        return [...cacheRows];
    }
}
