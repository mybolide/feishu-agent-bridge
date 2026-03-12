import test from "node:test";
import assert from "node:assert/strict";

import { resolveBoundSessionForRun } from "../gateway/server/session-policy.js";

test("resolveBoundSessionForRun should reuse bound session for opencode", () => {
  const sessionId = resolveBoundSessionForRun({
    sessionId: "ses-opencode-1",
    runtimeId: "opencode",
    unhealthy: false
  });

  assert.equal(sessionId, "ses-opencode-1");
});

test("resolveBoundSessionForRun should reject unhealthy iflow session", () => {
  const sessionId = resolveBoundSessionForRun({
    sessionId: "ses-iflow-1",
    runtimeId: "iflow-cli",
    unhealthy: true
  });

  assert.equal(sessionId, "");
});

test("resolveBoundSessionForRun should return empty when no bound session exists", () => {
  const sessionId = resolveBoundSessionForRun({
    sessionId: "",
    runtimeId: "opencode",
    unhealthy: false
  });

  assert.equal(sessionId, "");
});
