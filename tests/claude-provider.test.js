import test from "node:test";
import assert from "node:assert/strict";
import { createClaudeRuntimeProvider } from "../gateway/agent-runtime/providers/claude.js";
import { listRuntimeProviders, isRuntimeProviderAvailable, resolveRuntimeProvider } from "../gateway/agent-runtime/index.js";

test("createClaudeRuntimeProvider returns valid provider", () => {
  const provider = createClaudeRuntimeProvider();
  assert.equal(provider.id, "claude");
  assert.equal(provider.label, "Claude Code SDK");
  assert.ok(provider.session);
  assert.ok(provider.model);
  assert.ok(provider.run);
  assert.equal(typeof provider.session.list, "function");
  assert.equal(typeof provider.session.create, "function");
  assert.equal(typeof provider.session.abort, "function");
  assert.equal(typeof provider.model.list, "function");
  assert.equal(typeof provider.run.sendMessage, "function");
  assert.equal(typeof provider.run.isAbortLikeError, "function");
});

test("provider.model.list returns available models", async () => {
  const provider = createClaudeRuntimeProvider();
  const models = await provider.model.list();
  assert.ok(Array.isArray(models));
  assert.ok(models.length > 0);
  // 百炼 Coding Plan 支持的模型
  assert.ok(models.some((m) => m.id.includes("qwen")));
  assert.ok(models.some((m) => m.id.includes("glm")));
  assert.ok(models.some((m) => m.id.includes("kimi")));
});

test("claude provider is registered in runtime registry", () => {
  const providers = listRuntimeProviders({ includeUnavailable: true });
  const claudeProvider = providers.find((p) => p.id === "claude");
  assert.ok(claudeProvider);
  assert.equal(claudeProvider.label, "Claude Code SDK");
});

test("isRuntimeProviderAvailable returns true for claude by default", () => {
  const available = isRuntimeProviderAvailable("claude");
  assert.equal(available, true);
});

test("resolveRuntimeProvider returns claude provider instance", () => {
  const provider = resolveRuntimeProvider("claude");
  assert.ok(provider);
  assert.equal(provider.id, "claude");
});

test("isAbortLikeError detects abort errors", () => {
  const provider = createClaudeRuntimeProvider();
  const abortError = { name: "AbortError", message: "aborted" };
  assert.equal(provider.run.isAbortLikeError(abortError), true);
  assert.equal(provider.run.isAbortLikeError(new Error("normal error")), false);
});