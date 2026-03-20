import test from "node:test";
import assert from "node:assert/strict";
import { createGeminiRuntimeProvider } from "../gateway/agent-runtime/providers/gemini.js";
import { listRuntimeProviders, isRuntimeProviderAvailable, resolveRuntimeProvider } from "../gateway/agent-runtime/index.js";

test("createGeminiRuntimeProvider returns valid provider", () => {
  const provider = createGeminiRuntimeProvider();
  assert.equal(provider.id, "gemini-cli");
  assert.equal(provider.label, "Gemini CLI");
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
  const provider = createGeminiRuntimeProvider();
  const models = await provider.model.list();
  assert.ok(Array.isArray(models));
  assert.ok(models.length > 0);
  assert.ok(models.some((m) => m.id.includes("gemini")));
  assert.ok(models.some((m) => m.id.includes("flash")));
  assert.ok(models.some((m) => m.id.includes("pro")));
});

test("gemini provider is registered in runtime registry", () => {
  const providers = listRuntimeProviders({ includeUnavailable: true });
  const geminiProvider = providers.find((p) => p.id === "gemini-cli");
  assert.ok(geminiProvider);
  assert.equal(geminiProvider.label, "Gemini CLI");
});

test("isRuntimeProviderAvailable returns true for gemini by default", () => {
  const available = isRuntimeProviderAvailable("gemini-cli");
  assert.equal(available, true);
});

test("resolveRuntimeProvider returns gemini provider instance", () => {
  const provider = resolveRuntimeProvider("gemini-cli");
  assert.ok(provider);
  assert.equal(provider.id, "gemini-cli");
});

test("isAbortLikeError detects abort errors", () => {
  const provider = createGeminiRuntimeProvider();
  const abortError = { name: "AbortError", message: "aborted" };
  assert.equal(provider.run.isAbortLikeError(abortError), true);
  assert.equal(provider.run.isAbortLikeError(new Error("normal error")), false);
});