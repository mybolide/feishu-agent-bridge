import { spawn } from "node:child_process";
import net from "node:net";
import { config } from "../../config/index.js";
import { DEFAULT_OPENCODE_SERVER_URL, normalizeOpencodeServerUrl } from "../../config/opencode.js";

const DEFAULT_HEALTH_TIMEOUT_MS = 1500;
const DEFAULT_SCAN_LIMIT = 40;
const DEFAULT_DISCOVERY_ROUNDS = 3;
const DEFAULT_DISCOVERY_RETRY_DELAY_MS = 400;
const DEFAULT_DISCOVERY_CACHE_TTL_MS = 5000;
const DEFAULT_DISCOVERY_PROCESS_SCAN_TIMEOUT_MS = 2000;
const DEFAULT_WATCHDOG_INTERVAL_MS = 15000;
const DEFAULT_AUTO_RESTART_WAIT_MS = 8000;
const DEFAULT_AUTO_RESTART_COOLDOWN_MS = 20000;
const DEFAULT_PORT_PROBE_TIMEOUT_MS = 450;
const LEGACY_LOOPBACK_BASE_PORTS = [24096, 14096];

function safeInt(raw, fallback) {
  const value = Number.parseInt(String(raw || "").trim(), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

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

const HEALTH_TIMEOUT_MS = safeInt(process.env.OPENCODE_HEALTHCHECK_TIMEOUT_MS, DEFAULT_HEALTH_TIMEOUT_MS);
const DISCOVERY_SCAN_LIMIT = safeInt(process.env.OPENCODE_DISCOVERY_SCAN_LIMIT, DEFAULT_SCAN_LIMIT);
const DISCOVERY_ROUNDS = safeInt(process.env.OPENCODE_DISCOVERY_ROUNDS, DEFAULT_DISCOVERY_ROUNDS);
const DISCOVERY_RETRY_DELAY_MS = safeInt(process.env.OPENCODE_DISCOVERY_RETRY_DELAY_MS, DEFAULT_DISCOVERY_RETRY_DELAY_MS);
const DISCOVERY_CACHE_TTL_MS = safeInt(process.env.OPENCODE_DISCOVERY_CACHE_TTL_MS, DEFAULT_DISCOVERY_CACHE_TTL_MS);
const DISCOVERY_PROCESS_SCAN_ENABLED = parseBoolean(process.env.OPENCODE_DISCOVERY_PROCESS_SCAN_ENABLED, true);
const DISCOVERY_PROCESS_SCAN_TIMEOUT_MS = safeInt(process.env.OPENCODE_DISCOVERY_PROCESS_SCAN_TIMEOUT_MS, DEFAULT_DISCOVERY_PROCESS_SCAN_TIMEOUT_MS);
const WATCHDOG_ENABLED = parseBoolean(process.env.OPENCODE_WATCHDOG_ENABLED, true);
const WATCHDOG_INTERVAL_MS = safeInt(process.env.OPENCODE_WATCHDOG_INTERVAL_MS, DEFAULT_WATCHDOG_INTERVAL_MS);
const AUTO_RESTART_ENABLED = parseBoolean(process.env.OPENCODE_AUTO_RESTART_ENABLED, true);
const AUTO_RESTART_WAIT_MS = safeInt(process.env.OPENCODE_AUTO_RESTART_WAIT_MS, DEFAULT_AUTO_RESTART_WAIT_MS);
const AUTO_RESTART_COOLDOWN_MS = safeInt(process.env.OPENCODE_AUTO_RESTART_COOLDOWN_MS, DEFAULT_AUTO_RESTART_COOLDOWN_MS);
const PORT_PROBE_TIMEOUT_MS = safeInt(process.env.OPENCODE_PORT_PROBE_TIMEOUT_MS, DEFAULT_PORT_PROBE_TIMEOUT_MS);

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

let cachedBaseUrl = "";
let cachedAt = 0;
let inflightResolve = null;
let lastLoggedBaseUrl = "";
let lastLoggedProcessPorts = "";
let watchdogTimer = null;
let watchdogInFlight = false;
let restartInFlight = null;
let lastRestartAt = 0;

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

function parseBaseUrlHostAndPort(baseUrl) {
  const parsed = parseBaseUrl(baseUrl);
  const protocol = parsed.protocol || "http:";
  const hostname = parsed.hostname || "127.0.0.1";
  const port = parsed.port ? Number(parsed.port) : (protocol === "https:" ? 443 : 80);
  return { protocol, hostname, port };
}

function getLoopbackBaseUrl(rawBaseUrl) {
  const { protocol, hostname, port } = parseBaseUrlHostAndPort(rawBaseUrl);
  return `${protocol}//${hostname}:${port}`;
}

export function buildOpencodeCandidateBaseUrls(
  rawBaseUrl = config.opencodeServerUrl,
  scanLimit = DISCOVERY_SCAN_LIMIT,
  extraLoopbackPorts = []
) {
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
  for (const rawPort of extraLoopbackPorts) {
    const port = Number.parseInt(String(rawPort || "").trim(), 10);
    if (!Number.isFinite(port) || port <= 0) {
      continue;
    }
    pushCandidate(`${protocol}//${hostname}:${port}`);
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

function parseOpencodeServePort(commandLine = "") {
  const text = String(commandLine || "");
  if (!text) {
    return 0;
  }
  const normalized = text.toLowerCase();
  if (!normalized.includes("opencode") || !normalized.includes(" serve")) {
    return 0;
  }
  const hostMatch = text.match(/--hostname(?:\s+|=)([^\s"']+)/i);
  if (hostMatch && hostMatch[1]) {
    const hostname = hostMatch[1].trim().toLowerCase();
    if (hostname && !LOOPBACK_HOSTS.has(hostname)) {
      return 0;
    }
  }
  const portMatch = text.match(/--port(?:\s+|=)(\d+)/i);
  if (!portMatch || !portMatch[1]) {
    return 0;
  }
  const port = Number.parseInt(portMatch[1], 10);
  return Number.isFinite(port) && port > 0 ? port : 0;
}

function parseOpencodeServeProcess(commandLine = "", processId = 0) {
  const port = parseOpencodeServePort(commandLine);
  if (port <= 0) {
    return null;
  }
  const pid = Number.parseInt(String(processId || "0"), 10);
  return {
    processId: Number.isFinite(pid) && pid > 0 ? pid : 0,
    port,
    commandLine: String(commandLine || "")
  };
}

function runCommand(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timeoutId = null;
    let settled = false;
    const finalize = (fn) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      fn();
    };

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => finalize(() => reject(error)));
    child.on("close", (code) => {
      if (code === 0) {
        finalize(() => resolve({ stdout, stderr }));
        return;
      }
      const detail = [stdout.trim(), stderr.trim()].filter(Boolean).join(" ").trim();
      finalize(() => reject(new Error(detail || `${command} exited with code ${code}`)));
    });
    timeoutId = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      finalize(() => reject(new Error(`${command} timed out after ${timeoutMs}ms`)));
    }, Math.max(500, Number(timeoutMs || DISCOVERY_PROCESS_SCAN_TIMEOUT_MS)));
  });
}

function escapePowerShellLiteral(value = "") {
  return String(value || "").replace(/'/g, "''");
}

function detectWindowsCommandPriority(commandPath = "") {
  const value = String(commandPath || "").trim().toLowerCase();
  if (value.endsWith(".exe")) {
    return 0;
  }
  if (value.endsWith(".cmd")) {
    return 1;
  }
  if (value.endsWith(".bat")) {
    return 2;
  }
  if (value.endsWith(".ps1")) {
    return 3;
  }
  return 99;
}

function pickPreferredWindowsCommandPath(paths = []) {
  if (!Array.isArray(paths) || paths.length === 0) {
    return "";
  }
  const sorted = [...paths]
    .map((row) => String(row || "").trim())
    .filter(Boolean)
    .sort((a, b) => {
      const p = detectWindowsCommandPriority(a) - detectWindowsCommandPriority(b);
      if (p !== 0) {
        return p;
      }
      return a.localeCompare(b);
    });
  return sorted[0] || "";
}

async function resolveWindowsLaunchCommand(command = "") {
  const raw = String(command || "").trim();
  if (!raw) {
    return "";
  }
  if (/[\\/]/.test(raw) || /^[a-zA-Z]:/.test(raw) || raw.startsWith(".")) {
    return raw;
  }
  try {
    const result = await runCommand("where.exe", [raw], 2000);
    const candidates = String(result.stdout || "")
      .split(/\r?\n/g)
      .map((line) => String(line || "").trim())
      .filter(Boolean);
    const preferred = pickPreferredWindowsCommandPath(candidates);
    return preferred || raw;
  } catch {
    return raw;
  }
}

async function launchOpencodeServeInBackground(command, hostname, port) {
  const args = ["serve", "--hostname", String(hostname || "127.0.0.1"), "--port", String(port)];
  const rawCommand = String(command || "").trim();
  if (!rawCommand) {
    throw new Error("empty opencode command");
  }
  if (process.platform === "win32") {
    const resolvedCommand = await resolveWindowsLaunchCommand(rawCommand);
    const lower = resolvedCommand.toLowerCase();
    let filePath = resolvedCommand;
    let argValues = args;
    if (lower.endsWith(".ps1")) {
      filePath = "powershell.exe";
      argValues = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", resolvedCommand, ...args];
    }
    const filePathLiteral = escapePowerShellLiteral(filePath);
    const argList = argValues.map((arg) => `'${escapePowerShellLiteral(arg)}'`).join(", ");
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `Start-Process -WindowStyle Hidden -FilePath '${filePathLiteral}' -ArgumentList @(${argList})`
    ].join("; ");
    await runCommand(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      6000
    );
    return;
  }
  const child = spawn(rawCommand, args, { stdio: "ignore", detached: true });
  child.unref();
}

function normalizeList(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (value === null || value === undefined) {
    return [];
  }
  return [value];
}

async function discoverOpencodeServeProcesses() {
  if (!DISCOVERY_PROCESS_SCAN_ENABLED) {
    return [];
  }
  const rows = [];
  try {
    if (process.platform === "win32") {
      const script = "$rows = Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'opencode*' } | Select-Object ProcessId,CommandLine; $rows | ConvertTo-Json -Depth 4 -Compress";
      const result = await runCommand(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        DISCOVERY_PROCESS_SCAN_TIMEOUT_MS
      );
      const payload = String(result.stdout || "").trim();
      if (payload && payload !== "null") {
        const parsed = JSON.parse(payload);
        for (const row of normalizeList(parsed)) {
          const processInfo = parseOpencodeServeProcess(row?.CommandLine || "", row?.ProcessId || 0);
          if (processInfo) {
            rows.push(processInfo);
          }
        }
      }
    } else {
      const result = await runCommand("ps", ["-ax", "-o", "pid=,command="], DISCOVERY_PROCESS_SCAN_TIMEOUT_MS);
      const stdout = String(result.stdout || "");
      for (const line of stdout.split(/\r?\n/g)) {
        const match = line.match(/^\s*(\d+)\s+(.*)$/);
        if (!match) {
          continue;
        }
        const processInfo = parseOpencodeServeProcess(match[2], Number.parseInt(match[1], 10));
        if (processInfo) {
          rows.push(processInfo);
        }
      }
    }
  } catch {
    return [];
  }
  const dedup = new Map();
  for (const row of rows) {
    const key = `${row.processId}:${row.port}:${row.commandLine}`;
    if (!dedup.has(key)) {
      dedup.set(key, row);
    }
  }
  return [...dedup.values()];
}

async function resolveDiscoveredProcessPorts(rawBaseUrl) {
  if (!isLoopbackBaseUrl(rawBaseUrl)) {
    return [];
  }
  const processes = await discoverOpencodeServeProcesses();
  const ports = [...new Set(processes.map((row) => row.port).filter((port) => port > 0))];
  const key = ports.join(",");
  if (key && key !== lastLoggedProcessPorts) {
    lastLoggedProcessPorts = key;
    console.log(`[trace][opencode] discovered serve ports from process list ports=${key}`);
  }
  return ports;
}

function probeTcpPort(hostname, port, timeoutMs = PORT_PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: hostname, port: Number(port) });
    let settled = false;
    const done = (ok) => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        socket.destroy();
      } catch {}
      resolve(Boolean(ok));
    };
    socket.setTimeout(Math.max(200, Number(timeoutMs || PORT_PROBE_TIMEOUT_MS)));
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function killOpencodeServeProcessesOnPort(targetPort, discoveredProcesses = []) {
  if (process.platform !== "win32") {
    return false;
  }
  const pids = [...new Set(
    discoveredProcesses
      .filter((row) => Number(row?.port) === Number(targetPort) && Number(row?.processId) > 0)
      .map((row) => Number(row.processId))
  )];
  if (pids.length === 0) {
    return false;
  }
  let killedAny = false;
  for (const pid of pids) {
    try {
      await runCommand("cmd.exe", ["/c", `taskkill /PID ${pid} /T /F`], 5000);
      killedAny = true;
    } catch {}
  }
  if (killedAny) {
    await sleep(700);
  }
  return killedAny;
}

async function waitForHealthyBaseUrl(baseUrl, timeoutMs = AUTO_RESTART_WAIT_MS) {
  const deadline = Date.now() + Math.max(1000, Number(timeoutMs || AUTO_RESTART_WAIT_MS));
  while (Date.now() < deadline) {
    if (await isHealthyBaseUrl(baseUrl, HEALTH_TIMEOUT_MS)) {
      return true;
    }
    await sleep(500);
  }
  return false;
}

async function resolveRestartTargets(configuredBaseUrl, discoveredProcesses) {
  const configuredInfo = parseBaseUrlHostAndPort(configuredBaseUrl);
  if (await isHealthyBaseUrl(configuredBaseUrl, HEALTH_TIMEOUT_MS)) {
    return { reusedBaseUrl: configuredBaseUrl, restartTargets: [] };
  }

  const discoveredPorts = [...new Set(discoveredProcesses.map((row) => row.port).filter((port) => port > 0))];
  const configuredOccupied = await probeTcpPort(configuredInfo.hostname, configuredInfo.port);
  if (!configuredOccupied) {
    return { reusedBaseUrl: "", restartTargets: [configuredBaseUrl] };
  }

  if (discoveredPorts.includes(configuredInfo.port)) {
    const killed = await killOpencodeServeProcessesOnPort(configuredInfo.port, discoveredProcesses);
    if (killed) {
      const occupiedAfterKill = await probeTcpPort(configuredInfo.hostname, configuredInfo.port);
      if (!occupiedAfterKill) {
        return { reusedBaseUrl: "", restartTargets: [configuredBaseUrl] };
      }
    }
    if (await isHealthyBaseUrl(configuredBaseUrl, HEALTH_TIMEOUT_MS)) {
      return { reusedBaseUrl: configuredBaseUrl, restartTargets: [] };
    }
  }

  const scanCandidates = buildOpencodeCandidateBaseUrls(configuredBaseUrl, DISCOVERY_SCAN_LIMIT, discoveredPorts);
  for (const candidate of scanCandidates) {
    const info = parseBaseUrlHostAndPort(candidate);
    if (info.port === configuredInfo.port) {
      continue;
    }
    const occupied = await probeTcpPort(info.hostname, info.port);
    if (!occupied) {
      return { reusedBaseUrl: "", restartTargets: [candidate] };
    }
    if (!discoveredPorts.includes(info.port)) {
      continue;
    }
    if (await isHealthyBaseUrl(candidate, HEALTH_TIMEOUT_MS)) {
      return { reusedBaseUrl: candidate, restartTargets: [] };
    }
    const killed = await killOpencodeServeProcessesOnPort(info.port, discoveredProcesses);
    if (killed) {
      const occupiedAfterKill = await probeTcpPort(info.hostname, info.port);
      if (!occupiedAfterKill) {
        return { reusedBaseUrl: "", restartTargets: [candidate] };
      }
    }
  }

  return { reusedBaseUrl: "", restartTargets: [configuredBaseUrl] };
}

async function tryRestartLocalOpencodeGateway(rawBaseUrl, reason = "health-check") {
  if (!AUTO_RESTART_ENABLED || !isLoopbackBaseUrl(rawBaseUrl)) {
    return false;
  }
  if (restartInFlight) {
    return await restartInFlight;
  }
  const promise = (async () => {
    const now = Date.now();
    if (now - lastRestartAt < AUTO_RESTART_COOLDOWN_MS) {
      return false;
    }
    lastRestartAt = now;

    const configuredBaseUrl = getLoopbackBaseUrl(rawBaseUrl);
    const discoveredProcesses = await discoverOpencodeServeProcesses();
    const { reusedBaseUrl, restartTargets } = await resolveRestartTargets(configuredBaseUrl, discoveredProcesses);
    if (reusedBaseUrl) {
      cachedBaseUrl = reusedBaseUrl;
      cachedAt = Date.now();
      lastLoggedBaseUrl = reusedBaseUrl;
      return true;
    }

    const commandCandidates = [];
    const envCommand = String(process.env.OPENCODE_COMMAND || "").trim();
    if (envCommand) {
      commandCandidates.push(envCommand);
    }
    commandCandidates.push("opencode");
    const commands = [...new Set(commandCandidates)];
    const targets = restartTargets.length > 0 ? restartTargets : [configuredBaseUrl];

    for (const targetBaseUrl of targets) {
      const info = parseBaseUrlHostAndPort(targetBaseUrl);
      for (const command of commands) {
        try {
          await launchOpencodeServeInBackground(command, info.hostname, info.port);
        } catch {
          continue;
        }
        if (await waitForHealthyBaseUrl(targetBaseUrl, AUTO_RESTART_WAIT_MS)) {
          cachedBaseUrl = targetBaseUrl;
          cachedAt = Date.now();
          lastLoggedBaseUrl = targetBaseUrl;
          console.warn(`[trace][opencode] auto-restarted local gateway baseUrl=${targetBaseUrl} reason=${reason} command=${command}`);
          return true;
        }
      }
    }

    return false;
  })();

  restartInFlight = promise;
  try {
    return await promise;
  } finally {
    if (restartInFlight === promise) {
      restartInFlight = null;
    }
  }
}

async function resolveHealthyBaseUrlInternal() {
  const configuredBaseUrl = parseBaseUrl().toString().replace(/\/$/, "");
  let processPorts = await resolveDiscoveredProcessPorts(configuredBaseUrl);
  let candidates = buildOpencodeCandidateBaseUrls(configuredBaseUrl, DISCOVERY_SCAN_LIMIT, processPorts);
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

  if (await tryRestartLocalOpencodeGateway(configuredBaseUrl, "discovery-failed")) {
    processPorts = await resolveDiscoveredProcessPorts(configuredBaseUrl);
    candidates = buildOpencodeCandidateBaseUrls(configuredBaseUrl, DISCOVERY_SCAN_LIMIT, processPorts);
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

async function runWatchdogTick() {
  if (watchdogInFlight) {
    return;
  }
  watchdogInFlight = true;
  try {
    const configuredBaseUrl = parseBaseUrl().toString().replace(/\/$/, "");
    if (!isLoopbackBaseUrl(configuredBaseUrl)) {
      return;
    }
    const resolved = await resolveOpencodeBaseUrl({ forceRefresh: true });
    if (await isHealthyBaseUrl(resolved, HEALTH_TIMEOUT_MS)) {
      return;
    }
    const restarted = await tryRestartLocalOpencodeGateway(configuredBaseUrl, "watchdog");
    if (restarted) {
      await resolveOpencodeBaseUrl({ forceRefresh: true });
    }
  } catch (error) {
    const message = String(error?.message || error || "").trim();
    if (message) {
      console.warn(`[trace][opencode] watchdog check failed: ${message}`);
    }
  } finally {
    watchdogInFlight = false;
  }
}

function ensureWatchdogStarted() {
  if (!WATCHDOG_ENABLED || watchdogTimer) {
    return;
  }
  watchdogTimer = setInterval(() => {
    void runWatchdogTick();
  }, Math.max(1000, WATCHDOG_INTERVAL_MS));
  if (typeof watchdogTimer.unref === "function") {
    watchdogTimer.unref();
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
  ensureWatchdogStarted();
  return async (input, init) => {
    let baseUrl = await resolveOpencodeBaseUrl();
    const send = async (targetBaseUrl) => {
      if (input instanceof Request) {
        // 克隆请求，避免 body 被锁定的问题
        const clonedRequest = input.clone();
        const newUrl = rewriteRequestUrl(input.url, targetBaseUrl);
        const newInit = {
          method: clonedRequest.method,
          headers: clonedRequest.headers,
          body: clonedRequest.body,
          duplex: "half",  // Node.js fetch 要求当 body 是 stream 时设置 duplex
          ...init
        };
        return await fetch(newUrl, newInit);
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
      try {
        return await send(baseUrl);
      } catch (retryError) {
        if (!isRetriableFetchError(retryError)) {
          throw retryError;
        }
        const restarted = await tryRestartLocalOpencodeGateway(baseUrl, "request-failed");
        if (!restarted) {
          throw retryError;
        }
        baseUrl = await resolveOpencodeBaseUrl({ forceRefresh: true });
        return await send(baseUrl);
      }
    }
  };
}
