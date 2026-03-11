import { DatabaseSync } from "node:sqlite";
import { config } from "../../../config/index.js";
import { normalizeDirectory } from "./common.js";

let iflowSessionDb = null;

function ensureSessionDb() {
  if (iflowSessionDb) {
    return iflowSessionDb;
  }
  iflowSessionDb = new DatabaseSync(config.dbFile);
  iflowSessionDb.exec(`
    CREATE TABLE IF NOT EXISTS gateway_iflow_sessions (
      session_id TEXT PRIMARY KEY,
      directory TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_gateway_iflow_sessions_directory
      ON gateway_iflow_sessions(directory);
    CREATE INDEX IF NOT EXISTS idx_gateway_iflow_sessions_updated_at
      ON gateway_iflow_sessions(updated_at);
  `);
  return iflowSessionDb;
}

export function upsertSessionMeta(sessionId, directory, title = "") {
  const id = String(sessionId || "").trim();
  const dir = String(directory || "").trim();
  if (!id || !dir) {
    return;
  }
  ensureSessionDb().prepare(`
    INSERT INTO gateway_iflow_sessions (session_id, directory, title, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      directory = excluded.directory,
      title = CASE
        WHEN excluded.title != '' THEN excluded.title
        ELSE gateway_iflow_sessions.title
      END,
      updated_at = excluded.updated_at
  `).run(id, dir, String(title || "").trim(), Date.now());
}

export function listSessionMetaRows(directory) {
  const dir = String(directory || "").trim();
  const rows = ensureSessionDb().prepare(`
    SELECT session_id, directory, title, updated_at
    FROM gateway_iflow_sessions
    WHERE directory = ?
    ORDER BY updated_at DESC
    LIMIT 100
  `).all(dir);
  return Array.isArray(rows) ? rows : [];
}

export function resolveModelProbeDirectory() {
  const latest = ensureSessionDb().prepare(`
    SELECT directory
    FROM gateway_iflow_sessions
    WHERE directory != ''
    ORDER BY updated_at DESC
    LIMIT 1
  `).get();
  const dir = String(latest?.directory || "").trim();
  return normalizeDirectory(dir || process.cwd());
}
