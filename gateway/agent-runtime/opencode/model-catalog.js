import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { config } from "../../config/index.js";
import { createOpencodeResolvedFetch } from "./server-discovery.js";
const DEFAULT_MODEL_LIST_TIMEOUT_MS = 30_000;
const DEFAULT_MODEL_LIST_RETRY_ATTEMPTS = 3;
const DEFAULT_MODEL_LIST_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 4000;
let lastSuccessfulRows = [];
function safeInt(raw, fallback) {
    const value = Number.parseInt(String(raw || "").trim(), 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}
const MODEL_LIST_TIMEOUT_MS = safeInt(process.env.OPENCODE_MODEL_LIST_TIMEOUT_MS, DEFAULT_MODEL_LIST_TIMEOUT_MS);
const MODEL_LIST_RETRY_ATTEMPTS = safeInt(process.env.OPENCODE_MODEL_LIST_RETRY_ATTEMPTS, DEFAULT_MODEL_LIST_RETRY_ATTEMPTS);
const MODEL_LIST_RETRY_DELAY_MS = safeInt(process.env.OPENCODE_MODEL_LIST_RETRY_DELAY_MS, DEFAULT_MODEL_LIST_RETRY_DELAY_MS);
const OPENCODE_FETCH = createOpencodeResolvedFetch();
function readErrorCode(error) {
    const direct = String(error?.code || "").trim();
    if (direct) {
        return direct.toUpperCase();
    }
    const cause = error?.cause;
    if (cause && typeof cause === "object" && cause !== error) {
        return readErrorCode(cause);
    }
    return "";
}
function isRetriableProviderListError(error) {
    if (!error) {
        return false;
    }
    const code = readErrorCode(error);
    if ([
        "ECONNRESET",
        "ETIMEDOUT",
        "ECONNREFUSED",
        "EPIPE",
        "EAI_AGAIN",
        "ENOTFOUND",
        "UND_ERR_CONNECT_TIMEOUT",
        "UND_ERR_HEADERS_TIMEOUT",
        "UND_ERR_SOCKET"
    ].includes(code)) {
        return true;
    }
    const message = String(error?.message || error || "").trim().toLowerCase();
    return message.includes("fetch failed")
        || message.includes("timeout after")
        || message.includes("socket hang up")
        || message.includes("connection reset")
        || message.includes("network");
}
function retryDelayMs(baseDelayMs, attempt) {
    const base = Math.max(100, Number(baseDelayMs || 0) || DEFAULT_MODEL_LIST_RETRY_DELAY_MS);
    return Math.min(MAX_RETRY_DELAY_MS, base * Math.max(1, Number(attempt || 1)));
}
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
function normalizeConnectedProviderIds(rows) {
    const ids = new Set();
    const input = Array.isArray(rows) ? rows : [];
    for (const item of input) {
        if (typeof item === "string") {
            const id = item.trim();
            if (id) {
                ids.add(id);
            }
            continue;
        }
        if (!item || typeof item !== "object") {
            continue;
        }
        const id = String(item.id || "").trim();
        if (id) {
            ids.add(id);
        }
    }
    return ids;
}
async function listModelsViaSdk() {
    const authHeader = getServerAuthHeader();
    const client = createOpencodeClient({
        baseUrl: config.opencodeServerUrl,
        fetch: OPENCODE_FETCH,
        responseStyle: "data",
        throwOnError: true,
        ...(authHeader ? { headers: { Authorization: authHeader } } : {})
    });
    const startedAt = Date.now();
    let payload = null;
    for (let attempt = 1; attempt <= MODEL_LIST_RETRY_ATTEMPTS; attempt += 1) {
        try {
            payload = await withTimeout(client.provider.list(), MODEL_LIST_TIMEOUT_MS, "OpenCode provider.list");
            break;
        }
        catch (error) {
            if (attempt >= MODEL_LIST_RETRY_ATTEMPTS || !isRetriableProviderListError(error)) {
                throw error;
            }
            const delayMs = retryDelayMs(MODEL_LIST_RETRY_DELAY_MS, attempt);
            console.warn(`[trace][model] provider.list retry attempt=${attempt}/${MODEL_LIST_RETRY_ATTEMPTS} delayMs=${delayMs} reason=${error instanceof Error ? error.message : String(error)}`);
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
    }
    const allRows = payload && typeof payload === "object" ? payload.all : [];
    const connectedRows = payload && typeof payload === "object" ? payload.connected : [];
    const connectedIds = normalizeConnectedProviderIds(connectedRows);
    const connectedRowsWithModels = extractProviderModels(connectedRows);
    let models = [];
    if (connectedRowsWithModels.length > 0) {
        // Some SDK versions return connected as provider objects.
        models = dedupe(connectedRowsWithModels);
    }
    else if (connectedIds.size > 0) {
        // Current SDK returns connected as provider id list. Use it to filter all providers.
        const configuredProviders = (Array.isArray(allRows) ? allRows : []).filter((provider) => {
            if (!provider || typeof provider !== "object") {
                return false;
            }
            const providerId = String(provider.id || "").trim();
            return providerId ? connectedIds.has(providerId) : false;
        });
        models = dedupe(extractProviderModels(configuredProviders));
    }
    console.log(
        `[trace][model] listAvailableModels sdk-hit count=${models.length} connectedProviders=${Array.isArray(connectedRows) ? connectedRows.length : 0} connectedIds=${connectedIds.size} allProviders=${Array.isArray(allRows) ? allRows.length : 0} elapsedMs=${Date.now() - startedAt}`
    );
    return models;
}
export async function listAvailableModels(forceRefresh = false) {
    try {
        const rows = await listModelsViaSdk();
        lastSuccessfulRows = rows;
        return [...rows];
    }
    catch (error) {
        console.warn(`[trace][model] listAvailableModels sdk-error message=${error instanceof Error ? error.message : String(error)}`);
        return [...lastSuccessfulRows];
    }
}
