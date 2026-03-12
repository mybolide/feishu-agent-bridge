import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeOpencodeServerUrl } from "./opencode.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDir, "..", "..");

export { moduleDir, projectRoot };

function resolveProjectPath(rawPath, fallbackRelative) {
  const value = String(rawPath || "").trim();
  if (value) {
    return path.isAbsolute(value) ? path.resolve(value) : path.resolve(projectRoot, value);
  }
  return path.resolve(projectRoot, fallbackRelative);
}

function loadDotEnvFrom(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }
  const text = fs.readFileSync(filePath, "utf-8");
  for (const rawLine of text.split(/\r?\n/g)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const idx = line.indexOf("=");
    if (idx <= 0) {
      continue;
    }
    const key = line.slice(0, idx).trim();
    if (!key || process.env[key] !== undefined) {
      continue;
    }
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadDotEnvFrom(path.resolve(projectRoot, ".env"));
loadDotEnvFrom(path.resolve(process.cwd(), ".env"));

function parseBoolean(raw, fallback) {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value) {
    return fallback;
  }
  if (["1", "true", "yes", "on"].includes(value)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(value)) {
    return false;
  }
  return fallback;
}

function parsePositiveInt(raw, fallback) {
  const value = Number.parseInt(String(raw ?? "").trim(), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export const config = {
  opencodeServerUrl: normalizeOpencodeServerUrl(process.env.OPENCODE_SERVER_URL),
  feishuAppId: String(process.env.FEISHU_APP_ID || "").trim(),
  feishuAppSecret: String(process.env.FEISHU_APP_SECRET || "").trim(),
  feishuDomain: String(process.env.FEISHU_DOMAIN || "feishu").trim().toLowerCase(),
  feishuConnectionMode: String(process.env.FEISHU_CONNECTION_MODE || "long_connection").trim().toLowerCase(),
  feishuLogLevel: String(process.env.FEISHU_LOG_LEVEL || "info").trim().toLowerCase(),
  feishuHttpDisableProxy: parseBoolean(process.env.FEISHU_HTTP_DISABLE_PROXY, true),
  feishuWsStartupCheckTimeoutMs: parsePositiveInt(process.env.FEISHU_WS_STARTUP_CHECK_TIMEOUT_MS, 10000),
  feishuEncryptKey: String(process.env.FEISHU_ENCRYPT_KEY || "").trim(),
  dbFile: resolveProjectPath(process.env.DB_PATH, "data.db")
};
