import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_OPENCODE_SERVER_URL, normalizeOpencodeServerUrl } from "../gateway/config/opencode.js";

test("normalizeOpencodeServerUrl should fallback to the high port default", () => {
  assert.equal(normalizeOpencodeServerUrl(""), DEFAULT_OPENCODE_SERVER_URL);
  assert.equal(normalizeOpencodeServerUrl("not-a-url"), DEFAULT_OPENCODE_SERVER_URL);
});

test("normalizeOpencodeServerUrl should trim trailing slash", () => {
  assert.equal(
    normalizeOpencodeServerUrl("http://127.0.0.1:24096/"),
    "http://127.0.0.1:24096"
  );
});
