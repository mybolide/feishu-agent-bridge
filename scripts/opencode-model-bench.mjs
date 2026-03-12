import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { config } from "../gateway/config/index.js";
import { listAvailableModels } from "../gateway/agent-runtime/opencode/model-catalog.js";
import { createOpencodeResolvedFetch, resolveOpencodeBaseUrl } from "../gateway/agent-runtime/opencode/server-discovery.js";

function safeInt(raw, fallback) {
  const value = Number.parseInt(String(raw || "").trim(), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function getArgValue(flag, fallback = "") {
  const idx = process.argv.indexOf(flag);
  if (idx < 0 || idx + 1 >= process.argv.length) {
    return fallback;
  }
  return String(process.argv[idx + 1] || "").trim();
}

function getServerAuthHeader() {
  const username = String(process.env.OPENCODE_SERVER_USERNAME || "opencode").trim() || "opencode";
  const password = String(process.env.OPENCODE_SERVER_PASSWORD || "").trim();
  if (!password) {
    return "";
  }
  const token = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
  return `Basic ${token}`;
}

function formatMs(value) {
  return `${Number(value || 0).toFixed(1)}ms`;
}

function summarizeMs(samples) {
  const rows = Array.isArray(samples) ? samples.filter((n) => Number.isFinite(n) && n >= 0) : [];
  if (rows.length === 0) {
    return { min: 0, max: 0, avg: 0 };
  }
  const sorted = [...rows].sort((a, b) => a - b);
  const total = sorted.reduce((sum, item) => sum + item, 0);
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: total / sorted.length
  };
}

function createClient() {
  const authHeader = getServerAuthHeader();
  return createOpencodeClient({
    baseUrl: config.opencodeServerUrl,
    fetch: createOpencodeResolvedFetch(),
    responseStyle: "data",
    throwOnError: true,
    ...(authHeader ? { headers: { Authorization: authHeader } } : {})
  });
}

export async function testProviderListRaw(iterations = 1) {
  const client = createClient();
  const costs = [];
  let lastAll = 0;
  let lastConnected = 0;

  for (let i = 0; i < iterations; i += 1) {
    const started = Date.now();
    const payload = await client.provider.list();
    const elapsed = Date.now() - started;
    costs.push(elapsed);
    lastAll = Array.isArray(payload?.all) ? payload.all.length : 0;
    lastConnected = Array.isArray(payload?.connected) ? payload.connected.length : 0;
  }

  return {
    iterations,
    allProviders: lastAll,
    connectedProviders: lastConnected,
    latency: summarizeMs(costs)
  };
}

export async function testCatalogList(forceRefresh = true, iterations = 1) {
  const costs = [];
  let count = 0;
  let sample = [];

  for (let i = 0; i < iterations; i += 1) {
    const started = Date.now();
    const models = await listAvailableModels(forceRefresh);
    const elapsed = Date.now() - started;
    costs.push(elapsed);
    count = Array.isArray(models) ? models.length : 0;
    sample = Array.isArray(models) ? models.slice(0, 12) : [];
  }

  return {
    iterations,
    forceRefresh: Boolean(forceRefresh),
    modelCount: count,
    sample,
    latency: summarizeMs(costs)
  };
}

async function main() {
  const iterations = safeInt(getArgValue("--iterations", "1"), 1);
  const forceRefresh = getArgValue("--force-refresh", "true").toLowerCase() !== "false";
  const resolvedBaseUrl = await resolveOpencodeBaseUrl({ forceRefresh: true });

  console.log(`OpenCode server: ${resolvedBaseUrl}`);
  console.log(`Iterations: ${iterations}`);
  console.log("");

  console.log("Method A: SDK provider.list() raw");
  const raw = await testProviderListRaw(iterations);
  console.log(`  allProviders=${raw.allProviders} connectedProviders=${raw.connectedProviders}`);
  console.log(`  latency min=${formatMs(raw.latency.min)} avg=${formatMs(raw.latency.avg)} max=${formatMs(raw.latency.max)}`);
  console.log("");

  console.log(`Method B: model-catalog listAvailableModels(forceRefresh=${forceRefresh ? "true" : "false"})`);
  const catalog = await testCatalogList(forceRefresh, iterations);
  console.log(`  modelCount=${catalog.modelCount}`);
  console.log(`  latency min=${formatMs(catalog.latency.min)} avg=${formatMs(catalog.latency.avg)} max=${formatMs(catalog.latency.max)}`);
  console.log(`  sample=${catalog.sample.join(", ")}`);
}

main().catch((error) => {
  const message = error instanceof Error ? `${error.message}\n${error.stack || ""}` : String(error);
  console.error(`[diag:model] failed: ${message}`);
  process.exitCode = 1;
});
