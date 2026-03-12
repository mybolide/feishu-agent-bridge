import { config } from "../../config/index.js";
import { DEFAULT_OPENCODE_SERVER_URL, normalizeOpencodeServerUrl } from "../../config/opencode.js";

const DEFAULT_HEALTH_TIMEOUT_MS = 1500;
const DEFAULT_SCAN_LIMIT = 40;
const DEFAULT_DISCOVERY_ROUNDS = 3;
const DEFAULT_DISCOVERY_RETRY_DELAY_MS = 400;
const DEFAULT_DISCOVERY_CACHE_TTL_MS = 5000;
const LEGACY_LOOPBACK_BASE_PORTS = [24096, 14096];

function safeInt(raw, fallback) {
  const value = Number.parseInt(String(raw || "").trim(), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const HEALTH_TIMEOUT_MS = safeInt(process.env.OPENCODE_HEALTHCHECK_TIMEOUT_MS, DEFAULT_HEALTH_TIMEOUT_MS);
const DISCOVERY_SCAN_LIMIT = safeInt(process.env.OPENCODE_DISCOVERY_SCAN_LIMIT, DEFAULT_SCAN_LIMIT);
const DISCOVERY_ROUNDS = safeInt(process.env.OPENCODE_DISCOVERY_ROUNDS, DEFAULT_DISCOVERY_ROUNDS);
const DISCOVERY_RETRY_DELAY_MS = safeInt(process.env.OPENCODE_DISCOVERY_RETRY_DELAY_MS, DEFAULT_DISCOVERY_RETRY_DELAY_MS);
const DISCOVERY_CACHE_TTL_MS = safeInt(process.env.OPENCODE_DISCOVERY_CACHE_TTL_MS, DEFAULT_DISCOVERY_CACHE_TTL_MS);

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

let cachedBaseUrl = "";
let cachedAt = 0;
let inflightResolve = null;
let lastLoggedBaseUrl = "";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

function parseBaseUrl(rawBaseUrl = config.opencodeServerUrl) {
  const value = normalizeOpencodeServerUrl(rawBaseUrl);
  try {
    return new URL(value);
  } catch {
    return new URL(DEFAULT_OPENCODE_SERVER_URL);
  }
}

function isLoopbackBaseUrl(rawBaseUrl = config.opencodeServerUrl) {
  const parsed = parseBaseUrl(rawBaseUrl);
  return LOOPBACK_HOSTS.has(String(parsed.hostname || "").trim().toLowerCase());
}

export function buildOpencodeCandidateBaseUrls(rawBaseUrl = config.opencodeServerUrl, scanLimit = DISCOVERY_SCAN_LIMIT) {
  const parsed = parseBaseUrl(rawBaseUrl);
  const base = parsed.toString().replace(/\/$/, "");
  const candidates = [];
  const seen = new Set();
  const pushCandidate = (value) => {
    const normalized = String(value || "").replace(/\/$/, "");
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    candidates.push(normalized);
  };
  pushCandidate(base);
  if (!isLoopbackBaseUrl(base)) {
    return candidates;
  }
  const protocol = parsed.protocol || "http:";
  const hostname = parsed.hostname || "127.0.0.1";
  const startPort = parsed.port ? Number(parsed.port) : (protocol === "https:" ? 443 : 80);
  const limit = Math.max(0, Number(scanLimit || 0));
  const basePorts = [startPort, ...LEGACY_LOOPBACK_BASE_PORTS.filter((port) => port !== startPort)];
  for (const basePort of basePorts) {
    for (let offset = 0; offset <= limit; offset += 1) {
      const port = basePort + offset;
      pushCandidate(`${protocol}//${hostname}:${port}`);
    }
  }
  return candidates;
}

async function isHealthyBaseUrl(baseUrl, timeoutMs = HEALTH_TIMEOUT_MS) {
  const healthUrl = `${String(baseUrl || "").replace(/\/$/, "")}/global/health`;
  try {
    const response = await fetch(healthUrl, {
      signal: AbortSignal.timeout(Math.max(300, Number(timeoutMs || 0) || HEALTH_TIMEOUT_MS))
    });
    if (!response.ok) {
      return false;
    }
    const payload = await response.json().catch(() => null);
    return payload?.healthy === true && typeof payload?.version === "string" && payload.version.trim() !== "";
  } catch {
    return false;
  }
}

async function resolveHealthyBaseUrlInternal() {
  const configuredBaseUrl = parseBaseUrl().toString().replace(/\/$/, "");
  const candidates = buildOpencodeCandidateBaseUrls(configuredBaseUrl);
  for (let round = 1; round <= DISCOVERY_ROUNDS; round += 1) {
    for (const candidate of candidates) {
      if (await isHealthyBaseUrl(candidate)) {
        cachedBaseUrl = candidate;
        cachedAt = Date.now();
        if (candidate !== lastLoggedBaseUrl) {
          lastLoggedBaseUrl = candidate;
          console.log(`[trace][opencode] resolved healthy endpoint baseUrl=${candidate} configured=${configuredBaseUrl}`);
        }
        return candidate;
      }
    }
    if (round < DISCOVERY_ROUNDS) {
      await sleep(DISCOVERY_RETRY_DELAY_MS);
    }
  }
  cachedBaseUrl = configuredBaseUrl;
  cachedAt = 0;
  return configuredBaseUrl;
}

export async function resolveOpencodeBaseUrl(options = {}) {
  const forceRefresh = Boolean(options?.forceRefresh);
  if (!forceRefresh && cachedBaseUrl && Date.now() - cachedAt < DISCOVERY_CACHE_TTL_MS) {
    return cachedBaseUrl;
  }
  if (!forceRefresh && inflightResolve) {
    return await inflightResolve;
  }
  const promise = resolveHealthyBaseUrlInternal();
  inflightResolve = promise;
  try {
    return await promise;
  } finally {
    if (inflightResolve === promise) {
      inflightResolve = null;
    }
  }
}

function rewriteRequestUrl(rawUrl, baseUrl) {
  const source = new URL(String(rawUrl || ""));
  const target = new URL(String(baseUrl || "").replace(/\/$/, ""));
  source.protocol = target.protocol;
  source.hostname = target.hostname;
  source.port = target.port;
  return source.toString();
}

function isRetriableFetchError(error) {
  const code = String(error?.code || error?.cause?.code || "").trim().toUpperCase();
  if ([
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
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
    || message.includes("timeout")
    || message.includes("network")
    || message.includes("socket");
}

export function createOpencodeResolvedFetch() {
  return async (input, init) => {
    let baseUrl = await resolveOpencodeBaseUrl();
    const send = async (targetBaseUrl) => {
      if (input instanceof Request) {
        return await fetch(new Request(rewriteRequestUrl(input.url, targetBaseUrl), input), init);
      }
      if (input instanceof URL) {
        return await fetch(rewriteRequestUrl(input.toString(), targetBaseUrl), init);
      }
      return await fetch(rewriteRequestUrl(String(input || ""), targetBaseUrl), init);
    };
    try {
      return await send(baseUrl);
    } catch (error) {
      if (!isRetriableFetchError(error)) {
        throw error;
      }
      baseUrl = await resolveOpencodeBaseUrl({ forceRefresh: true });
      return await send(baseUrl);
    }
  };
}
