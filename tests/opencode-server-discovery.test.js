import test from "node:test";
import assert from "node:assert/strict";
import { buildOpencodeCandidateBaseUrls } from "../gateway/agent-runtime/opencode/server-discovery.js";

test("buildOpencodeCandidateBaseUrls should scan forward for loopback urls", () => {
  const rows = buildOpencodeCandidateBaseUrls("http://127.0.0.1:24096", 3);
  assert.deepEqual(rows, [
    "http://127.0.0.1:24096",
    "http://127.0.0.1:24097",
    "http://127.0.0.1:24098",
    "http://127.0.0.1:24099",
    "http://127.0.0.1:14096",
    "http://127.0.0.1:14097",
    "http://127.0.0.1:14098",
    "http://127.0.0.1:14099"
  ]);
});

test("buildOpencodeCandidateBaseUrls should keep remote urls unchanged", () => {
  const rows = buildOpencodeCandidateBaseUrls("https://api.example.com:2443", 5);
  assert.deepEqual(rows, ["https://api.example.com:2443"]);
});

test("buildOpencodeCandidateBaseUrls should append discovered loopback process ports", () => {
  const rows = buildOpencodeCandidateBaseUrls("http://127.0.0.1:24096", 0, [62570, 55702, 24096, 0, -1, "abc"]);
  assert.deepEqual(rows, [
    "http://127.0.0.1:24096",
    "http://127.0.0.1:14096",
    "http://127.0.0.1:62570",
    "http://127.0.0.1:55702"
  ]);
});
