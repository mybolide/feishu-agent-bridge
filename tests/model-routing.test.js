import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeModelList,
  pickPreferredModel,
  resolveRequestedModel
} from "../gateway/agent-runtime/model-routing.js";

test("normalizeModelList should trim and dedupe", () => {
  const rows = normalizeModelList([" code3/gpt-5.3-codex ", "", "iflowcn/glm-4.6", "code3/gpt-5.3-codex"]);
  assert.deepEqual(rows, ["code3/gpt-5.3-codex", "iflowcn/glm-4.6"]);
});

test("pickPreferredModel should prefer code3 for opencode", () => {
  const model = pickPreferredModel("opencode", [
    "iflowcn/glm-4.6",
    "code4/gpt-5.2-codex",
    "code3/gpt-5.3-codex"
  ]);
  assert.equal(model, "code3/gpt-5.3-codex");
});

test("resolveRequestedModel should keep requested model when matched", () => {
  const decision = resolveRequestedModel({
    runtimeId: "opencode",
    requestedModel: "iflowcn/glm-4.6",
    availableModels: ["iflowcn/glm-4.6", "code3/gpt-5.3-codex"],
    preferWhenEmpty: true
  });
  assert.equal(decision.model, "iflowcn/glm-4.6");
  assert.equal(decision.changed, false);
  assert.equal(decision.reason, "matched");
});

test("resolveRequestedModel should fallback when requested model is unavailable", () => {
  const decision = resolveRequestedModel({
    runtimeId: "opencode",
    requestedModel: "iflowcn/missing-model",
    availableModels: ["iflowcn/glm-4.6", "code3/gpt-5.3-codex"],
    preferWhenEmpty: true
  });
  assert.equal(decision.model, "code3/gpt-5.3-codex");
  assert.equal(decision.changed, true);
  assert.equal(decision.reason, "requested_unavailable");
});

test("resolveRequestedModel should select default model when empty and preferWhenEmpty", () => {
  const decision = resolveRequestedModel({
    runtimeId: "opencode",
    requestedModel: "",
    availableModels: ["iflowcn/glm-4.6", "code3/gpt-5.3-codex"],
    preferWhenEmpty: true
  });
  assert.equal(decision.model, "code3/gpt-5.3-codex");
  assert.equal(decision.changed, true);
  assert.equal(decision.reason, "default_selected");
});

test("resolveRequestedModel should keep empty when runtime does not force default", () => {
  const decision = resolveRequestedModel({
    runtimeId: "iflow-cli",
    requestedModel: "",
    availableModels: ["iflow-cli/glm-4.6"],
    preferWhenEmpty: false
  });
  assert.equal(decision.model, "");
  assert.equal(decision.changed, false);
  assert.equal(decision.reason, "empty");
});
