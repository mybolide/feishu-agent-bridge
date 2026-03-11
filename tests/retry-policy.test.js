import test from "node:test";
import assert from "node:assert/strict";
import {
  isIFlowFirstTokenTimeoutError,
  isOpenCodeFirstTokenTimeoutError,
  isIFlowSessionStateRetryableError,
  shouldRetryInCurrentSession,
  shouldRetryWithFreshSession
} from "../gateway/server/retry-policy.js";

test("isIFlowFirstTokenTimeoutError detects first-token timeout message", () => {
  const err = new Error("iFlow receive message session=abc firstToken=0 timeout after 60000ms");
  assert.equal(isIFlowFirstTokenTimeoutError(err), true);
});

test("shouldRetryWithFreshSession true for first iflow timeout attempt", () => {
  const err = new Error("iFlow receive message session=abc firstToken=0 timeout after 60000ms");
  assert.equal(shouldRetryWithFreshSession({
    runtimeId: "iflow-cli",
    error: err,
    attempt: 0,
    aborted: false
  }), true);
});

test("shouldRetryWithFreshSession false for non-iflow/aborted/retry-once", () => {
  const err = new Error("iFlow receive message session=abc firstToken=0 timeout after 60000ms");
  assert.equal(shouldRetryWithFreshSession({
    runtimeId: "opencode",
    error: err,
    attempt: 0,
    aborted: false
  }), false);
  assert.equal(shouldRetryWithFreshSession({
    runtimeId: "iflow-cli",
    error: err,
    attempt: 1,
    aborted: false
  }), false);
  assert.equal(shouldRetryWithFreshSession({
    runtimeId: "iflow-cli",
    error: err,
    attempt: 0,
    aborted: true
  }), false);
  const stateErr = new Error("Invalid request, detail: Not currently generating");
  assert.equal(shouldRetryWithFreshSession({
    runtimeId: "iflow-cli",
    error: stateErr,
    attempt: 0,
    aborted: false
  }), false);
});

test("isIFlowSessionStateRetryableError detects session-state errors", () => {
  const err = new Error("Invalid request, detail: Not currently generating");
  assert.equal(isIFlowSessionStateRetryableError(err), true);
});

test("shouldRetryInCurrentSession true for iflow session-state error on first attempt", () => {
  const err = new Error("Invalid request, detail: Not currently generating");
  assert.equal(shouldRetryInCurrentSession({
    runtimeId: "iflow-cli",
    error: err,
    attempt: 0,
    aborted: false
  }), true);
});

test("isOpenCodeFirstTokenTimeoutError detects OpenCode polling timeout", () => {
  const err = new Error("OpenCode 消息轮询超时（>90000ms）");
  assert.equal(isOpenCodeFirstTokenTimeoutError(err), true);
});

test("shouldRetryWithFreshSession false by default for opencode polling-timeout", () => {
  const err = new Error("OpenCode 消息轮询超时（>90000ms）");
  assert.equal(shouldRetryWithFreshSession({
    runtimeId: "opencode",
    error: err,
    attempt: 0,
    aborted: false
  }), false);
});

test("shouldRetryWithFreshSession supports env flag for opencode polling-timeout", () => {
  const err = new Error("OpenCode 消息轮询超时（>90000ms）");
  const prev = process.env.OPENCODE_TIMEOUT_RETRY_ENABLED;
  process.env.OPENCODE_TIMEOUT_RETRY_ENABLED = "true";
  try {
    assert.equal(shouldRetryWithFreshSession({
      runtimeId: "opencode",
      error: err,
      attempt: 0,
      aborted: false
    }), true);
  } finally {
    if (prev === undefined) {
      delete process.env.OPENCODE_TIMEOUT_RETRY_ENABLED;
    } else {
      process.env.OPENCODE_TIMEOUT_RETRY_ENABLED = prev;
    }
  }
  assert.equal(shouldRetryWithFreshSession({
    runtimeId: "opencode",
    error: err,
    attempt: 1,
    aborted: false
  }), false);
});
