import { DatabaseSync } from "node:sqlite";
import { config } from "../config/index.js";

const DEFAULT_RUNTIME_TOOL_ID = "opencode";

let gatewayDb = null;

function normalizeRuntimeToolId(rawToolId) {
    const value = String(rawToolId || "").trim().toLowerCase();
    return value || DEFAULT_RUNTIME_TOOL_ID;
}

function tableHasColumn(db, table, column) {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all();
    return rows.some((row) => String(row?.name || "").trim() === column);
}
function ensureRunTableColumns(db) {
    if (!tableHasColumn(db, "gateway_run_refs", "status")) {
        db.exec("ALTER TABLE gateway_run_refs ADD COLUMN status TEXT NOT NULL DEFAULT ''");
    }
    if (!tableHasColumn(db, "gateway_queued_runs", "status")) {
        db.exec("ALTER TABLE gateway_queued_runs ADD COLUMN status TEXT NOT NULL DEFAULT ''");
    }
}
function ensureThreadStateColumns(db) {
    if (!tableHasColumn(db, "gateway_thread_state", "thread_tool")) {
        db.exec("ALTER TABLE gateway_thread_state ADD COLUMN thread_tool TEXT NOT NULL DEFAULT ''");
    }
}

function threadToolStateDefaults(threadId, toolId) {
    return {
        thread_id: threadId,
        tool_id: normalizeRuntimeToolId(toolId),
        thread_model: "",
        thread_session: "",
        updated_at: 0
    };
}

function getThreadToolStateRow(threadId, toolId) {
    const key = String(threadId || "").trim();
    if (!key) {
        return null;
    }
    const normalizedToolId = normalizeRuntimeToolId(toolId);
    const db = ensureGatewayDb();
    return db.prepare(`
        SELECT thread_id, tool_id, thread_model, thread_session, updated_at
        FROM gateway_thread_tool_state
        WHERE thread_id = ? AND tool_id = ?
    `).get(key, normalizedToolId) ?? null;
}

function upsertThreadToolState(threadId, toolId, patch) {
    const key = String(threadId || "").trim();
    if (!key) {
        return null;
    }
    const normalizedToolId = normalizeRuntimeToolId(toolId);
    const existing = getThreadToolStateRow(key, normalizedToolId) ?? threadToolStateDefaults(key, normalizedToolId);
    const next = {
        thread_id: key,
        tool_id: normalizedToolId,
        thread_model: patch.thread_model ?? existing.thread_model ?? "",
        thread_session: patch.thread_session ?? existing.thread_session ?? "",
        updated_at: Number(patch.updated_at ?? Date.now())
    };
    ensureGatewayDb().prepare(`
        INSERT INTO gateway_thread_tool_state (
          thread_id, tool_id, thread_model, thread_session, updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(thread_id, tool_id) DO UPDATE SET
          thread_model = excluded.thread_model,
          thread_session = excluded.thread_session,
          updated_at = excluded.updated_at
    `).run(next.thread_id, next.tool_id, next.thread_model, next.thread_session, next.updated_at);
    return next;
}

function resolveCurrentToolForThread(threadId) {
    const row = getThreadStateRow(threadId);
    return normalizeRuntimeToolId(row?.thread_tool || "");
}
function ensureGatewayDb() {
    if (gatewayDb) {
        return gatewayDb;
    }
    gatewayDb = new DatabaseSync(config.dbFile);
    gatewayDb.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS gateway_thread_state (
          thread_id TEXT PRIMARY KEY,
          repo_path TEXT NOT NULL DEFAULT '',
          branch TEXT NOT NULL DEFAULT 'main',
          thread_model TEXT NOT NULL DEFAULT '',
          thread_tool TEXT NOT NULL DEFAULT '',
          thread_path TEXT NOT NULL DEFAULT '',
          thread_session TEXT NOT NULL DEFAULT '',
          updated_at INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS gateway_run_refs (
          run_id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT '',
          payload_json TEXT NOT NULL DEFAULT '{}',
          updated_at INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS gateway_queued_runs (
          run_id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT '',
          payload_json TEXT NOT NULL DEFAULT '{}',
          updated_at INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS gateway_thread_tool_state (
          thread_id TEXT NOT NULL,
          tool_id TEXT NOT NULL,
          thread_model TEXT NOT NULL DEFAULT '',
          thread_session TEXT NOT NULL DEFAULT '',
          updated_at INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(thread_id, tool_id)
        );
        CREATE INDEX IF NOT EXISTS idx_gateway_thread_state_updated_at
          ON gateway_thread_state(updated_at);
        CREATE INDEX IF NOT EXISTS idx_gateway_run_refs_thread_id
          ON gateway_run_refs(thread_id);
        CREATE INDEX IF NOT EXISTS idx_gateway_run_refs_updated_at
          ON gateway_run_refs(updated_at);
        CREATE INDEX IF NOT EXISTS idx_gateway_queued_runs_thread_id
          ON gateway_queued_runs(thread_id);
        CREATE INDEX IF NOT EXISTS idx_gateway_queued_runs_status
          ON gateway_queued_runs(status);
        CREATE INDEX IF NOT EXISTS idx_gateway_queued_runs_updated_at
          ON gateway_queued_runs(updated_at);
        CREATE INDEX IF NOT EXISTS idx_gateway_thread_tool_state_thread_id
          ON gateway_thread_tool_state(thread_id);
        CREATE INDEX IF NOT EXISTS idx_gateway_thread_tool_state_updated_at
          ON gateway_thread_tool_state(updated_at);
    `);
    ensureThreadStateColumns(gatewayDb);
    ensureRunTableColumns(gatewayDb);
    return gatewayDb;
}
function threadStateDefaults(threadId) {
    return {
        thread_id: threadId,
        repo_path: "",
        branch: "main",
        thread_model: "",
        thread_tool: "",
        thread_path: "",
        thread_session: "",
        updated_at: 0
    };
}
function getThreadStateRow(threadId) {
    const key = String(threadId || "").trim();
    if (!key) {
        return null;
    }
    const db = ensureGatewayDb();
    return db.prepare(`
        SELECT thread_id, repo_path, branch, thread_model, thread_tool, thread_path, thread_session, updated_at
        FROM gateway_thread_state
        WHERE thread_id = ?
    `).get(key) ?? null;
}
function upsertThreadState(threadId, patch) {
    const key = String(threadId || "").trim();
    if (!key) {
        return null;
    }
    const existing = getThreadStateRow(key) ?? threadStateDefaults(key);
    const next = {
        thread_id: key,
        repo_path: patch.repo_path ?? existing.repo_path ?? "",
        branch: patch.branch ?? existing.branch ?? "main",
        thread_model: patch.thread_model ?? existing.thread_model ?? "",
        thread_tool: patch.thread_tool ?? existing.thread_tool ?? "",
        thread_path: patch.thread_path ?? existing.thread_path ?? "",
        thread_session: patch.thread_session ?? existing.thread_session ?? "",
        updated_at: Number(patch.updated_at ?? Date.now())
    };
    ensureGatewayDb().prepare(`
        INSERT INTO gateway_thread_state (
          thread_id, repo_path, branch, thread_model, thread_tool, thread_path, thread_session, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(thread_id) DO UPDATE SET
          repo_path = excluded.repo_path,
          branch = excluded.branch,
          thread_model = excluded.thread_model,
          thread_tool = excluded.thread_tool,
          thread_path = excluded.thread_path,
          thread_session = excluded.thread_session,
          updated_at = excluded.updated_at
    `).run(next.thread_id, next.repo_path, next.branch, next.thread_model, next.thread_tool, next.thread_path, next.thread_session, next.updated_at);
    return next;
}
function parseJsonRow(raw) {
    if (typeof raw !== "string" || !raw.trim()) {
        return null;
    }
    try {
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
function getRunRow(table, runId) {
    const key = String(runId || "").trim();
    if (!key) {
        return null;
    }
    return ensureGatewayDb().prepare(`SELECT run_id, thread_id, status, payload_json, updated_at FROM ${table} WHERE run_id = ?`).get(key) ?? null;
}
function upsertRunRow(table, run) {
    const item = { ...run };
    const runId = String(item.runId || "").trim();
    if (!runId) {
        return null;
    }
    const threadId = String(item.threadId || "").trim();
    const status = String(item.status || "").trim();
    const updatedAt = Number(item.updatedAt || Date.now());
    ensureGatewayDb().prepare(`
        INSERT INTO ${table} (run_id, thread_id, status, payload_json, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          thread_id = excluded.thread_id,
          status = excluded.status,
          payload_json = excluded.payload_json,
          updated_at = excluded.updated_at
    `).run(runId, threadId, status, JSON.stringify({ ...item, runId, threadId, status, updatedAt }), updatedAt);
    return { ...item, runId, threadId, status, updatedAt };
}
export function upsertBinding(threadId, repoPath, branch) {
    const row = {
        threadId,
        repoPath,
        branch,
        updatedAt: Date.now()
    };
    console.log(`[db-state] bind thread=${threadId} repo=${repoPath} branch=${branch}`);
    upsertThreadState(threadId, {
        repo_path: repoPath,
        branch,
        thread_path: repoPath,
        updated_at: row.updatedAt
    });
    return row;
}
export function getBinding(threadId) {
    const row = getThreadStateRow(threadId);
    if (!row) {
        return null;
    }
    const existingRepo = String(row.repo_path || "").trim();
    if (existingRepo) {
        return {
            threadId,
            repoPath: existingRepo,
            branch: String(row.branch || "main").trim() || "main",
            updatedAt: Number(row.updated_at || Date.now())
        };
    }
    return null;
}
export function clearBinding(threadId) {
    const key = String(threadId || "").trim();
    if (!key || !getThreadStateRow(key)) {
        return;
    }
    ensureGatewayDb().prepare("DELETE FROM gateway_thread_tool_state WHERE thread_id = ?").run(key);
    upsertThreadState(key, {
        repo_path: "",
        branch: "main",
        thread_path: "",
        thread_session: "",
        updated_at: Date.now()
    });
}

export function clearThreadToolState(threadId) {
    const key = String(threadId || "").trim();
    if (!key) {
        return;
    }
    ensureGatewayDb().prepare("DELETE FROM gateway_thread_tool_state WHERE thread_id = ?").run(key);
}
export function saveRunRef(run) {
    upsertRunRow("gateway_run_refs", run);
}
export function patchRunRef(runId, patch) {
    const existing = getRunRef(runId);
    if (!existing) {
        return null;
    }
    return upsertRunRow("gateway_run_refs", { ...existing, ...patch, runId: existing.runId });
}
export function getRunRef(runId) {
    const row = getRunRow("gateway_run_refs", runId);
    return row ? parseJsonRow(row.payload_json) : null;
}
export function upsertQueuedRun(run) {
    upsertRunRow("gateway_queued_runs", run);
}
export function patchQueuedRun(runId, patch) {
    const existing = getQueuedRun(runId);
    if (!existing) {
        return null;
    }
    return upsertRunRow("gateway_queued_runs", { ...existing, ...patch, runId: existing.runId, updatedAt: Date.now() });
}
export function getQueuedRun(runId) {
    const row = getRunRow("gateway_queued_runs", runId);
    return row ? parseJsonRow(row.payload_json) : null;
}
function listQueuedRows() {
    const rows = ensureGatewayDb().prepare(`
        SELECT payload_json FROM gateway_queued_runs ORDER BY updated_at DESC
    `).all();
    return rows.map((row) => parseJsonRow(row.payload_json)).filter(Boolean);
}
export function latestQueuedRunForThread(threadId, statuses = []) {
    const rows = listQueuedRows().filter((row) => row.threadId === threadId);
    if (!Array.isArray(statuses) || statuses.length === 0) {
        return rows[0] ?? null;
    }
    return rows.find((row) => statuses.includes(row.status)) ?? null;
}
export function listQueuedRuns(threadId) {
    const rows = listQueuedRows();
    return threadId ? rows.filter((row) => row.threadId === threadId) : rows;
}
export function queuedRunSnapshot() {
    const rows = listQueuedRuns();
    let pending = 0;
    let running = 0;
    let completed = 0;
    let failed = 0;
    let aborted = 0;
    for (const row of rows) {
        if (row.status === "pending")
            pending += 1;
        else if (row.status === "running")
            running += 1;
        else if (row.status === "completed")
            completed += 1;
        else if (row.status === "failed")
            failed += 1;
        else if (row.status === "aborted")
            aborted += 1;
    }
    return { pending, running, completed, failed, aborted };
}
export function reconcileQueuedRunsOnStartup(reason = "node-gateway restarted before run completed") {
    const staleRuns = [];
    for (const row of listQueuedRows()) {
        if (!row || (row.status !== "pending" && row.status !== "running")) {
            continue;
        }
        const next = {
            ...row,
            status: "failed",
            error: row.error || reason,
            updatedAt: Date.now()
        };
        upsertRunRow("gateway_queued_runs", next);
        staleRuns.push(next);
        const runRef = getRunRef(next.runId);
        if (runRef) {
            upsertRunRow("gateway_run_refs", {
                ...runRef,
                error: next.error,
                interruptedAt: next.updatedAt,
                restartRecovered: true,
                updatedAt: next.updatedAt
            });
        }
    }
    if (staleRuns.length > 0) {
        console.log(`[db-state] reconciled stale queued runs count=${staleRuns.length}`);
    }
    return staleRuns;
}
export function setThreadModel(threadId, model) {
    const key = String(threadId || "").trim();
    const value = String(model || "").trim();
    if (!key || !value) {
        return;
    }
    const toolId = resolveCurrentToolForThread(key);
    upsertThreadToolState(key, toolId, {
        thread_model: value,
        updated_at: Date.now()
    });
    upsertThreadState(key, {
        thread_model: value,
        updated_at: Date.now()
    });
}
export function getThreadModel(threadId) {
    const key = String(threadId || "").trim();
    if (!key) {
        return "";
    }
    return String(getThreadStateRow(key)?.thread_model || "").trim();
}
export function clearThreadModel(threadId) {
    const key = String(threadId || "").trim();
    if (!key) {
        return;
    }
    const toolId = resolveCurrentToolForThread(key);
    upsertThreadToolState(key, toolId, {
        thread_model: "",
        updated_at: Date.now()
    });
    upsertThreadState(key, {
        thread_model: "",
        updated_at: Date.now()
    });
}
export function setThreadTool(threadId, toolId) {
    const key = String(threadId || "").trim();
    const value = normalizeRuntimeToolId(toolId);
    if (!key) {
        return;
    }
    upsertThreadState(key, {
        thread_tool: value,
        updated_at: Date.now()
    });
}
export function getThreadTool(threadId) {
    const key = String(threadId || "").trim();
    if (!key) {
        return "";
    }
    return String(getThreadStateRow(key)?.thread_tool || "").trim();
}
export function setThreadPath(threadId, cwd) {
    const key = String(threadId || "").trim();
    const value = String(cwd || "").trim();
    if (!key || !value) {
        return;
    }
    upsertThreadState(key, {
        thread_path: value,
        updated_at: Date.now()
    });
}
export function getThreadPath(threadId) {
    const key = String(threadId || "").trim();
    if (!key) {
        return "";
    }
    return String(getThreadStateRow(key)?.thread_path || "").trim();
}
export function setThreadSession(threadId, sessionId) {
    const key = String(threadId || "").trim();
    const value = String(sessionId || "").trim();
    if (!key || !value) {
        return;
    }
    const toolId = resolveCurrentToolForThread(key);
    upsertThreadToolState(key, toolId, {
        thread_session: value,
        updated_at: Date.now()
    });
    upsertThreadState(key, {
        thread_session: value,
        updated_at: Date.now()
    });
}
export function getThreadSession(threadId) {
    const key = String(threadId || "").trim();
    if (!key) {
        return "";
    }
    return String(getThreadStateRow(key)?.thread_session || "").trim();
}
export function clearThreadSession(threadId) {
    const key = String(threadId || "").trim();
    if (!key) {
        return;
    }
    const toolId = resolveCurrentToolForThread(key);
    upsertThreadToolState(key, toolId, {
        thread_session: "",
        updated_at: Date.now()
    });
    upsertThreadState(key, {
        thread_session: "",
        updated_at: Date.now()
    });
}

export function switchThreadTool(threadId, toolId) {
    const key = String(threadId || "").trim();
    if (!key) {
        return { toolId: normalizeRuntimeToolId(toolId), sessionId: "", model: "" };
    }
    const nextToolId = normalizeRuntimeToolId(toolId);
    const now = Date.now();
    const current = getThreadStateRow(key) ?? threadStateDefaults(key);
    const currentToolId = normalizeRuntimeToolId(current.thread_tool || "");
    upsertThreadToolState(key, currentToolId, {
        thread_model: String(current.thread_model || "").trim(),
        thread_session: String(current.thread_session || "").trim(),
        updated_at: now
    });
    const target = getThreadToolStateRow(key, nextToolId) ?? threadToolStateDefaults(key, nextToolId);
    upsertThreadState(key, {
        thread_tool: nextToolId,
        thread_model: String(target.thread_model || "").trim(),
        thread_session: String(target.thread_session || "").trim(),
        updated_at: now
    });
    return {
        toolId: nextToolId,
        sessionId: String(target.thread_session || "").trim(),
        model: String(target.thread_model || "").trim()
    };
}
