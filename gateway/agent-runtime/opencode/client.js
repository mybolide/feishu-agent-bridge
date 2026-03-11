import fs from "node:fs";
import path from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { config } from "../../config/index.js";
const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MESSAGE_POLL_INTERVAL_MS = 2000;
const DEFAULT_MESSAGE_POLL_TIMEOUT_MS = 90 * 1000;
const DEFAULT_SESSION_LIST_TIMEOUT_MS = 15 * 1000;
const DEFAULT_STREAM_PROGRESS_INTERVAL_MS = 1200;
const DEFAULT_EVENT_STREAM_RETRY_DELAY_MS = 1200;
function safeInt(raw, fallback) {
    const value = Number.parseInt(String(raw || "").trim(), 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}
const REQUEST_TIMEOUT_MS = safeInt(process.env.OPENCODE_REQUEST_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS);
const MESSAGE_POLL_INTERVAL_MS = safeInt(process.env.OPENCODE_MESSAGE_POLL_INTERVAL_MS, DEFAULT_MESSAGE_POLL_INTERVAL_MS);
const MESSAGE_POLL_TIMEOUT_MS = safeInt(process.env.OPENCODE_MESSAGE_POLL_TIMEOUT_MS, DEFAULT_MESSAGE_POLL_TIMEOUT_MS);
const SESSION_LIST_TIMEOUT_MS = safeInt(process.env.OPENCODE_SESSION_LIST_TIMEOUT_MS, DEFAULT_SESSION_LIST_TIMEOUT_MS);
const STREAM_PROGRESS_INTERVAL_MS = safeInt(process.env.OPENCODE_STREAM_PROGRESS_INTERVAL_MS, DEFAULT_STREAM_PROGRESS_INTERVAL_MS);
const EVENT_STREAM_RETRY_DELAY_MS = safeInt(process.env.OPENCODE_EVENT_STREAM_RETRY_DELAY_MS, DEFAULT_EVENT_STREAM_RETRY_DELAY_MS);
function createAbortError(message = "operation aborted") {
    const error = new Error(message);
    error.name = "AbortError";
    return error;
}
export function isAbortLikeError(error) {
    if (!error) {
        return false;
    }
    const name = String(error?.name || "").trim().toLowerCase();
    const message = String(error?.message || error || "").trim().toLowerCase();
    return name === "aborterror"
        || message.includes("abort")
        || message.includes("aborted")
        || message.includes("cancelled");
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
function normalizeDirectory(raw) {
    const value = String(raw || "").trim();
    if (!value) {
        return "";
    }
    let resolved = /^[A-Za-z]:[\\/]/.test(value) ? value : path.resolve(value);
    try {
        const realpath = fs.realpathSync.native || fs.realpathSync;
        resolved = realpath(resolved);
    }
    catch {
        // keep resolved path when realpath is unavailable
    }
    if (process.platform === "win32") {
        let normalizedWin = path.win32.normalize(String(resolved || ""));
        if (/^[a-z]:\\/.test(normalizedWin)) {
            normalizedWin = `${normalizedWin[0].toUpperCase()}${normalizedWin.slice(1)}`;
        }
        return normalizedWin;
    }
    let normalized = path.posix.normalize(String(resolved || "").replace(/\\/g, "/"));
    if (/^[a-z]:\//.test(normalized)) {
        normalized = `${normalized[0].toUpperCase()}${normalized.slice(1)}`;
    }
    return normalized;
}
function extractSessionDirectory(item) {
    const direct = ["directory", "cwd", "path", "project_path", "projectPath"];
    for (const key of direct) {
        const value = String(item?.[key] || "").trim();
        if (value) {
            return value;
        }
    }
    const project = item?.project;
    if (project && typeof project === "object") {
        for (const key of ["path", "cwd", "directory"]) {
            const value = String(project[key] || "").trim();
            if (value) {
                return value;
            }
        }
    }
    return "";
}
function withTimeout(promise, timeoutMs, label, options = {}) {
    const ms = Math.max(1000, Number(timeoutMs || 0) || REQUEST_TIMEOUT_MS);
    let timer = null;
    const signal = options?.signal;
    let abortHandler = null;
    if (signal?.aborted) {
        return Promise.reject(createAbortError(`${label} aborted before start`));
    }
    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
            reject(new Error(`${label} timeout after ${ms}ms`));
        }, ms);
        if (signal) {
            abortHandler = () => reject(createAbortError(`${label} aborted`));
            signal.addEventListener("abort", abortHandler, { once: true });
        }
    });
    return Promise.race([promise, timeoutPromise]).finally(() => {
        if (timer) {
            clearTimeout(timer);
        }
        if (signal && abortHandler) {
            signal.removeEventListener("abort", abortHandler);
        }
    });
}
function createSdkClient(directory) {
    const authHeader = getServerAuthHeader();
    return createOpencodeClient({
        baseUrl: config.opencodeServerUrl,
        responseStyle: "data",
        throwOnError: true,
        ...(directory ? { directory } : {}),
        ...(authHeader ? { headers: { Authorization: authHeader } } : {})
    });
}
function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, Math.max(0, ms || 0));
    });
}
function extractMessageInfo(item) {
    if (!item || typeof item !== "object") {
        return {};
    }
    if (item.info && typeof item.info === "object") {
        return item.info;
    }
    return item;
}
function extractMessageId(item) {
    const info = extractMessageInfo(item);
    return String(info.id || item?.id || "").trim();
}
function extractMessageCreatedAt(item) {
    const info = extractMessageInfo(item);
    const time = info.time;
    if (time && typeof time === "object") {
        const created = Number(time.created || 0);
        if (Number.isFinite(created) && created > 0) {
            return created;
        }
    }
    return 0;
}
function extractMessageCompletedAt(item) {
    const info = extractMessageInfo(item);
    const time = info.time;
    if (time && typeof time === "object") {
        const completed = Number(time.completed || 0);
        if (Number.isFinite(completed) && completed > 0) {
            return completed;
        }
    }
    return 0;
}
function messageRole(item) {
    const info = extractMessageInfo(item);
    return String(info.role || "").trim().toLowerCase();
}
function extractTextFromParts(parts) {
    if (!Array.isArray(parts)) {
        return "";
    }
    const chunks = [];
    for (const item of parts) {
        if (!item || typeof item !== "object") {
            continue;
        }
        if (String(item.type || "") === "text" && typeof item.text === "string") {
            chunks.push(item.text);
        }
    }
    return chunks.join("").trim();
}
function latestAssistantMessage(rows, sinceCreatedAt = 0, seenMessageIds = new Set()) {
    for (let i = rows.length - 1; i >= 0; i -= 1) {
        const row = rows[i];
        if (messageRole(row) !== "assistant") {
            continue;
        }
        const messageId = extractMessageId(row);
        if (messageId && seenMessageIds.has(messageId)) {
            continue;
        }
        const createdAt = extractMessageCreatedAt(row);
        if (createdAt < sinceCreatedAt) {
            continue;
        }
        const text = extractTextFromParts(row.parts);
        const completedAt = extractMessageCompletedAt(row);
        return {
            id: messageId,
            text,
            createdAt,
            completedAt,
            completed: completedAt > 0
        };
    }
    return null;
}
function latestAssistantText(rows, sinceCreatedAt = 0, seenMessageIds = new Set()) {
    const latest = latestAssistantMessage(rows, sinceCreatedAt, seenMessageIds);
    return String(latest?.text || "");
}
function normalizeEventPayload(raw) {
    if (!raw || typeof raw !== "object") {
        return null;
    }
    if (raw.payload && typeof raw.payload === "object") {
        return raw.payload;
    }
    return raw;
}
function normalizeModelPayload(model) {
    const value = String(model || "").trim();
    if (!value) {
        return undefined;
    }
    const idx = value.indexOf("/");
    if (idx <= 0 || idx === value.length - 1) {
        return undefined;
    }
    return {
        providerID: value.slice(0, idx),
        modelID: value.slice(idx + 1)
    };
}
function toSessionRows(rawRows) {
    const rows = Array.isArray(rawRows) ? rawRows : [];
    const output = [];
    for (const item of rows) {
        if (!item || typeof item !== "object") {
            continue;
        }
        const id = String(item.id || "").trim();
        if (!id) {
            continue;
        }
        output.push({
            id,
            title: String(item.title || ""),
            directory: extractSessionDirectory(item) || String(item.directory || "")
        });
    }
    return output;
}
async function fetchSessionMessages(client, directory, sessionId, requestOptions = {}) {
    if (requestOptions?.signal?.aborted) {
        throw createAbortError("OpenCode session.messages aborted");
    }
    const rows = await withTimeout(client.session.messages({
        sessionID: sessionId,
        directory,
        limit: 200
    }, requestOptions), REQUEST_TIMEOUT_MS, `OpenCode session.messages session=${sessionId}`, requestOptions);
    return Array.isArray(rows) ? rows.filter((item) => !!item && typeof item === "object") : [];
}
async function waitForAssistantMessage(client, directory, sessionId, sinceCreatedAt = 0, seenMessageIds = new Set(), requestOptions = {}) {
    const deadline = Date.now() + MESSAGE_POLL_TIMEOUT_MS;
    let polls = 0;
    const startedAt = Date.now();
    while (Date.now() <= deadline) {
        if (requestOptions?.signal?.aborted) {
            throw createAbortError("OpenCode waitForAssistantMessage aborted");
        }
        const rows = await fetchSessionMessages(client, directory, sessionId, requestOptions);
        polls += 1;
        const output = latestAssistantText(rows, sinceCreatedAt, seenMessageIds);
        if (output) {
            console.log(`[trace][session] waitForAssistantMessage hit directory=${directory} session=${sessionId} polls=${polls} elapsedMs=${Date.now() - startedAt} outputLen=${output.length}`);
            return output;
        }
        await sleep(MESSAGE_POLL_INTERVAL_MS);
    }
    throw new Error(`OpenCode 消息轮询超时（>${MESSAGE_POLL_TIMEOUT_MS}ms）`);
}
function startAssistantProgressPolling(client, directory, sessionId, sinceCreatedAt, seenMessageIds, onProgress, requestOptions = {}) {
    if (typeof onProgress !== "function") {
        return async () => undefined;
    }
    let stopped = false;
    let inflight = Promise.resolve();
    let lastProgressKey = "";
    const poll = async () => {
        while (!stopped) {
            if (requestOptions?.signal?.aborted) {
                return;
            }
            try {
                const rows = await fetchSessionMessages(client, directory, sessionId, requestOptions);
                const latest = latestAssistantMessage(rows, sinceCreatedAt, seenMessageIds);
                const text = String(latest?.text || "");
                const nextKey = `${String(latest?.id || "")}:${text.length}:${latest?.completed ? 1 : 0}`;
                if (text && nextKey !== lastProgressKey) {
                    lastProgressKey = nextKey;
                    await onProgress({
                        messageId: String(latest?.id || ""),
                        text,
                        completed: Boolean(latest?.completed)
                    });
                }
            }
            catch (error) {
                if (isAbortLikeError(error)) {
                    return;
                }
                console.warn(`[trace][session] progress polling failed session=${sessionId}`, error);
            }
            await sleep(STREAM_PROGRESS_INTERVAL_MS);
        }
    };
    inflight = poll();
    return async () => {
        stopped = true;
        await inflight.catch(() => undefined);
    };
}
function startAssistantProgressEventStreaming(client, directory, sessionId, sinceCreatedAt, seenMessageIds, onProgress, requestOptions = {}) {
    if (typeof onProgress !== "function") {
        return async () => undefined;
    }
    let stopped = false;
    const streamAbortController = new AbortController();
    const upstreamSignal = requestOptions?.signal;
    let upstreamAbortHandler = null;
    if (upstreamSignal) {
        if (upstreamSignal.aborted) {
            streamAbortController.abort();
        }
        else {
            upstreamAbortHandler = () => streamAbortController.abort();
            upstreamSignal.addEventListener("abort", upstreamAbortHandler, { once: true });
        }
    }
    const streamRequestOptions = { ...requestOptions, signal: streamAbortController.signal };
    const assistantStates = new Map();
    let inflight = Promise.resolve();
    const upsertAssistantState = (messageID, createdAt = 0) => {
        const key = String(messageID || "").trim();
        if (!key || seenMessageIds.has(key)) {
            return null;
        }
        const nextCreatedAt = Number(createdAt || 0);
        if (nextCreatedAt > 0 && nextCreatedAt < sinceCreatedAt) {
            return null;
        }
        const existed = assistantStates.get(key);
        if (existed) {
            if (nextCreatedAt > 0 && (!existed.createdAt || nextCreatedAt < existed.createdAt)) {
                existed.createdAt = nextCreatedAt;
            }
            return existed;
        }
        const created = {
            messageID: key,
            createdAt: nextCreatedAt,
            completed: false,
            partOrder: [],
            partTexts: new Map()
        };
        assistantStates.set(key, created);
        return created;
    };
    const mergePartText = (state, partID, text, append = false) => {
        if (!state || !partID) {
            return;
        }
        const key = String(partID || "").trim();
        if (!key) {
            return;
        }
        const incoming = String(text || "");
        const prev = String(state.partTexts.get(key) || "");
        state.partTexts.set(key, append ? `${prev}${incoming}` : incoming);
        if (!state.partOrder.includes(key)) {
            state.partOrder.push(key);
        }
    };
    const composeStateText = (state) => state.partOrder.map((id) => String(state.partTexts.get(id) || "")).join("");
    const emitStateProgress = async (state, completed = false) => {
        if (!state) {
            return;
        }
        const text = composeStateText(state);
        if (!text) {
            return;
        }
        await onProgress({
            messageId: state.messageID,
            text,
            completed: Boolean(completed || state.completed)
        });
    };
    const onEvent = async (rawEvent) => {
        const event = normalizeEventPayload(rawEvent);
        const type = String(event?.type || "").trim();
        if (!type) {
            return;
        }
        const properties = event?.properties && typeof event.properties === "object"
            ? event.properties
            : {};
        if (type === "message.updated") {
            const info = properties.info && typeof properties.info === "object" ? properties.info : {};
            if (String(info.sessionID || "").trim() !== sessionId) {
                return;
            }
            if (String(info.role || "").trim().toLowerCase() !== "assistant") {
                return;
            }
            const createdAt = Number(info?.time?.created || 0);
            const state = upsertAssistantState(info.id, createdAt);
            if (!state) {
                return;
            }
            const completedAt = Number(info?.time?.completed || 0);
            if (completedAt > 0 && !state.completed) {
                state.completed = true;
                await emitStateProgress(state, true);
            }
            return;
        }
        if (type === "message.part.delta") {
            if (String(properties.sessionID || "").trim() !== sessionId) {
                return;
            }
            if (String(properties.field || "").trim() !== "text") {
                return;
            }
            const state = assistantStates.get(String(properties.messageID || "").trim());
            if (!state) {
                return;
            }
            mergePartText(state, properties.partID, properties.delta, true);
            await emitStateProgress(state, false);
            return;
        }
        if (type === "message.part.updated") {
            const part = properties.part && typeof properties.part === "object" ? properties.part : {};
            if (String(part.sessionID || "").trim() !== sessionId) {
                return;
            }
            const state = assistantStates.get(String(part.messageID || "").trim());
            if (!state) {
                return;
            }
            const partType = String(part.type || "").trim();
            if (partType === "text") {
                mergePartText(state, part.id, part.text, false);
                await emitStateProgress(state, false);
                return;
            }
            if (partType === "step-finish") {
                state.completed = true;
                await emitStateProgress(state, true);
            }
        }
    };
    const streamLoop = async () => {
        while (!stopped) {
            if (streamRequestOptions?.signal?.aborted) {
                return;
            }
            try {
                const streamResult = await client.event.subscribe({ directory }, streamRequestOptions);
                for await (const item of streamResult?.stream || []) {
                    if (stopped || streamRequestOptions?.signal?.aborted) {
                        return;
                    }
                    await onEvent(item);
                }
            }
            catch (error) {
                if (isAbortLikeError(error)) {
                    return;
                }
                console.warn(`[trace][session] progress event stream failed session=${sessionId}`, error);
            }
            await sleep(EVENT_STREAM_RETRY_DELAY_MS);
        }
    };
    inflight = streamLoop();
    return async () => {
        stopped = true;
        streamAbortController.abort();
        await inflight.catch(() => undefined);
        if (upstreamSignal && upstreamAbortHandler) {
            upstreamSignal.removeEventListener("abort", upstreamAbortHandler);
        }
    };
}
function startAssistantProgressPump(client, directory, sessionId, sinceCreatedAt, seenMessageIds, onProgress, requestOptions = {}) {
    if (typeof onProgress !== "function") {
        return async () => undefined;
    }
    let lastProgressText = "";
    let lastProgressCompleted = false;
    const emitDedupedProgress = async (payload) => {
        const progress = payload && typeof payload === "object" ? payload : {};
        const text = String(progress?.text || "");
        const normalizedText = text.trim();
        if (!normalizedText) {
            return;
        }
        const messageId = String(progress?.messageId || "").trim();
        const completed = Boolean(progress?.completed);
        if (normalizedText === lastProgressText && completed === lastProgressCompleted) {
            return;
        }
        lastProgressText = normalizedText;
        lastProgressCompleted = completed;
        await onProgress({
            messageId,
            text: normalizedText,
            completed
        });
    };
    const stopEventStream = startAssistantProgressEventStreaming(
        client,
        directory,
        sessionId,
        sinceCreatedAt,
        seenMessageIds,
        emitDedupedProgress,
        requestOptions
    );
    const stopPolling = startAssistantProgressPolling(
        client,
        directory,
        sessionId,
        sinceCreatedAt,
        seenMessageIds,
        emitDedupedProgress,
        requestOptions
    );
    return async () => {
        await Promise.allSettled([stopEventStream(), stopPolling()]);
    };
}
export async function listSessions(directory) {
    const normalizedDir = normalizeDirectory(directory);
    const startedAt = Date.now();
    console.log(`[trace][session] listSessions start directory=${normalizedDir}`);
    const client = createSdkClient(normalizedDir);
    const rows = await withTimeout(client.session.list({
        directory: normalizedDir,
        limit: 100
    }), SESSION_LIST_TIMEOUT_MS, `OpenCode session.list directory=${normalizedDir}`);
    const normalizedRows = toSessionRows(rows);
    console.log(`[trace][session] listSessions sdk-hit directory=${normalizedDir} count=${normalizedRows.length} elapsedMs=${Date.now() - startedAt}`);
    return normalizedRows;
}
export async function createSession(directory, title) {
    const normalizedDir = normalizeDirectory(directory);
    const startedAt = Date.now();
    console.log(`[trace][session] createSession request directory=${normalizedDir} title=${JSON.stringify(String(title || ""))}`);
    const client = createSdkClient(normalizedDir);
    const created = await withTimeout(client.session.create({
        directory: normalizedDir,
        title
    }), REQUEST_TIMEOUT_MS, `OpenCode session.create directory=${normalizedDir}`);
    const id = String(created?.id || "").trim();
    if (!id) {
        throw new Error("OpenCode create session returned no session id");
    }
    console.log(`[trace][session] createSession created directory=${normalizedDir} session=${id} title=${JSON.stringify(String(created?.title || title || ""))} elapsedMs=${Date.now() - startedAt}`);
    return {
        id,
        title: String(created?.title || title || ""),
        directory: extractSessionDirectory(created) || normalizedDir
    };
}
export async function sendMessageToSession(directory, sessionId, text, model, options = {}) {
    const normalizedDir = normalizeDirectory(directory);
    console.log(`[trace][session] sendMessageToSession start directory=${normalizedDir} session=${sessionId} model=${model || ""} text=${JSON.stringify(String(text || "").slice(0, 120))}`);
    const client = createSdkClient(normalizedDir);
    const baselineStartedAt = Date.now();
    const requestOptions = options?.signal ? { signal: options.signal } : {};
    const baselineRows = await fetchSessionMessages(client, normalizedDir, sessionId, requestOptions);
    console.log(`[trace][session] sendMessageToSession baseline-loaded directory=${normalizedDir} session=${sessionId} rows=${baselineRows.length} elapsedMs=${Date.now() - baselineStartedAt}`);
    const seenAssistantIds = new Set(baselineRows
        .filter((item) => messageRole(item) === "assistant")
        .map((item) => extractMessageId(item))
        .filter(Boolean));
    const sinceCreatedAt = baselineRows.reduce((max, item) => Math.max(max, extractMessageCreatedAt(item)), 0);
    const onProgress = typeof options?.onProgress === "function" ? options.onProgress : null;
    let promptStartedAt = 0;
    let firstProgressAt = 0;
    let progressEvents = 0;
    const emitProgress = async (progress) => {
        const payload = progress && typeof progress === "object" ? progress : {};
        const content = String(payload?.text || "");
        if (content) {
            progressEvents += 1;
            if (!firstProgressAt && promptStartedAt > 0) {
                firstProgressAt = Date.now();
                console.log(`[trace][session] sendMessageToSession first-progress directory=${normalizedDir} session=${sessionId} ttfbMs=${firstProgressAt - promptStartedAt} textLen=${content.length}`);
            }
        }
        if (onProgress) {
            await onProgress(payload);
        }
    };
    let lastProgressText = "";
    let lastProgressCompleted = false;
    const progressCallback = onProgress
        ? async (progress) => {
            const payload = progress && typeof progress === "object" ? progress : {};
            const text = String(payload?.text || "").trim();
            if (!text) {
                return;
            }
            const completed = Boolean(payload?.completed);
            if (text === lastProgressText && completed === lastProgressCompleted) {
                return;
            }
            lastProgressText = text;
            lastProgressCompleted = completed;
            await emitProgress({ ...payload, text, completed });
        }
        : null;
    const payload = {
        sessionID: sessionId,
        directory: normalizedDir,
        parts: [{ type: "text", text }]
    };
    const modelPayload = normalizeModelPayload(model);
    if (modelPayload) {
        payload.model = modelPayload;
    }
    const stopProgressPolling = startAssistantProgressPump(
        client,
        normalizedDir,
        sessionId,
        sinceCreatedAt,
        seenAssistantIds,
        progressCallback,
        requestOptions
    );
    promptStartedAt = Date.now();
    try {
        let syncOutput = "";
        if (typeof client?.session?.promptAsync === "function") {
            await withTimeout(client.session.promptAsync(payload, requestOptions), REQUEST_TIMEOUT_MS, `OpenCode session.prompt_async session=${sessionId}`, requestOptions);
            console.log(`[trace][session] sendMessageToSession prompt-accepted directory=${normalizedDir} session=${sessionId} elapsedMs=${Date.now() - promptStartedAt}`);
        }
        else {
            const result = await withTimeout(client.session.prompt(payload, requestOptions), REQUEST_TIMEOUT_MS, `OpenCode session.prompt session=${sessionId}`, requestOptions);
            syncOutput = extractTextFromParts(result?.parts);
            console.log(`[trace][session] sendMessageToSession prompt-finished directory=${normalizedDir} session=${sessionId} outputLen=${syncOutput.length} elapsedMs=${Date.now() - promptStartedAt}`);
        }
        if (syncOutput) {
            if (progressCallback) {
                await progressCallback({ messageId: "", text: syncOutput, completed: true });
            }
            return syncOutput;
        }
        console.log(`[trace][session] sendMessageToSession wait-poll directory=${normalizedDir} session=${sessionId} sinceCreatedAt=${sinceCreatedAt}`);
        const waitedOutput = await waitForAssistantMessage(client, normalizedDir, sessionId, sinceCreatedAt, seenAssistantIds, requestOptions);
        if (progressCallback && waitedOutput) {
            await progressCallback({ messageId: "", text: waitedOutput, completed: true });
        }
        return waitedOutput;
    }
    finally {
        const ttfbMs = firstProgressAt && promptStartedAt ? (firstProgressAt - promptStartedAt) : -1;
        if (promptStartedAt > 0) {
            console.log(`[trace][session] sendMessageToSession progress-summary directory=${normalizedDir} session=${sessionId} ttfbMs=${ttfbMs} progressEvents=${progressEvents}`);
        }
        await stopProgressPolling();
    }
}
export async function abortSession(directory, sessionId) {
    const normalizedDir = normalizeDirectory(directory);
    const client = createSdkClient(normalizedDir);
    await withTimeout(client.session.abort({
        sessionID: sessionId,
        directory: normalizedDir
    }), REQUEST_TIMEOUT_MS, `OpenCode session.abort session=${sessionId}`);
}
