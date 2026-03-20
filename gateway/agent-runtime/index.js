import { createOpenCodeRuntimeProvider } from "./providers/opencode.js";
import { createIFlowRuntimeProvider } from "./providers/iflow-cli.js";
import { createClaudeRuntimeProvider } from "./providers/claude.js";

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

const IFLOW_RUNTIME_ENABLED = parseBoolean(process.env.IFLOW_RUNTIME_ENABLED, true);
const CLAUDE_RUNTIME_ENABLED = parseBoolean(process.env.CLAUDE_RUNTIME_ENABLED, true);

const RUNTIME_PROVIDER_REGISTRY = [
  {
    id: "opencode",
    label: "OpenCode SDK",
    available: true,
    reason: "",
    create: createOpenCodeRuntimeProvider
  },
  {
    id: "iflow-cli",
    label: "iFlow CLI",
    available: IFLOW_RUNTIME_ENABLED,
    reason: IFLOW_RUNTIME_ENABLED ? "" : "IFLOW_RUNTIME_ENABLED=false",
    create: IFLOW_RUNTIME_ENABLED ? createIFlowRuntimeProvider : null
  },
  {
    id: "claude",
    label: "Claude Code SDK",
    available: CLAUDE_RUNTIME_ENABLED,
    reason: CLAUDE_RUNTIME_ENABLED ? "" : "CLAUDE_RUNTIME_ENABLED=false",
    create: CLAUDE_RUNTIME_ENABLED ? createClaudeRuntimeProvider : null
  },
  {
    id: "gemini-cli",
    label: "Gemini CLI",
    available: false,
    reason: "暂未接入，请先实现 provider",
    create: null
  },
  {
    id: "codex-cli",
    label: "Codex CLI",
    available: false,
    reason: "暂未接入，请先实现 provider",
    create: null
  }
];

const PROVIDER_CACHE = new Map();

function resolveDefaultRuntimeKey() {
  return String(process.env.AGENT_RUNTIME_PROVIDER || "opencode").trim().toLowerCase();
}

function resolveProviderEntry(providerId) {
  const key = String(providerId || "").trim().toLowerCase();
  if (!key) {
    return null;
  }
  return RUNTIME_PROVIDER_REGISTRY.find((item) => item.id === key) || null;
}

function instantiateProvider(entry) {
  if (!entry || !entry.available || typeof entry.create !== "function") {
    return null;
  }
  if (PROVIDER_CACHE.has(entry.id)) {
    return PROVIDER_CACHE.get(entry.id);
  }
  const provider = entry.create();
  PROVIDER_CACHE.set(entry.id, provider);
  return provider;
}

export function listRuntimeProviders(options = {}) {
  const includeUnavailable = options?.includeUnavailable !== false;
  return RUNTIME_PROVIDER_REGISTRY
    .filter((item) => includeUnavailable || item.available)
    .map((item) => ({
      id: item.id,
      label: item.label,
      available: item.available,
      reason: item.reason || ""
    }));
}

export function getDefaultRuntimeProviderId() {
  const key = resolveDefaultRuntimeKey();
  const entry = resolveProviderEntry(key);
  if (entry?.available) {
    return entry.id;
  }
  return "opencode";
}

export function isRuntimeProviderAvailable(providerId) {
  const entry = resolveProviderEntry(providerId);
  return Boolean(entry?.available);
}

export function resolveRuntimeProvider(providerId) {
  const entry = resolveProviderEntry(providerId);
  return instantiateProvider(entry);
}

export function getAgentRuntimeProvider(providerId = "") {
  const requested = String(providerId || "").trim().toLowerCase();
  if (requested) {
    const resolved = resolveRuntimeProvider(requested);
    if (resolved) {
      return resolved;
    }
    console.warn(`[runtime] unavailable provider=${requested}, fallback=${getDefaultRuntimeProviderId()}`);
  }
  const fallbackId = getDefaultRuntimeProviderId();
  const fallback = resolveRuntimeProvider(fallbackId) || resolveRuntimeProvider("opencode");
  if (!fallback) {
    throw new Error("No available runtime provider. Ensure at least opencode provider is enabled.");
  }
  return fallback;
}
