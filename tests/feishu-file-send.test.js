import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sendFileFromFile } from "../gateway/feishu/sdk/messenger.js";

async function withTempFile(name, content, run) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-file-send-"));
  const filePath = path.join(tempDir, name);
  fs.writeFileSync(filePath, content);
  try {
    await run(filePath);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test("sendFileFromFile sends the original file when upload succeeds", { concurrency: false }, async () => {
  await withTempFile("demo.txt", "hello", async (filePath) => {
    const uploads = [];
    const messages = [];
    let fallbackCalled = false;

    const result = await sendFileFromFile("oc_test_chat", filePath, {
      uploadFile: async (uploadPath, uploadName) => {
        uploads.push({ uploadPath, uploadName });
        return { fileKey: "file-success" };
      },
      sendMessage: async (payload) => {
        messages.push(payload);
      },
      createZipFallback: async () => {
        fallbackCalled = true;
        throw new Error("fallback should not be used");
      }
    });

    assert.equal(result.fallbackUsed, false);
    assert.equal(result.uploadName, "demo.txt");
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].uploadPath, path.resolve(filePath));
    assert.equal(uploads[0].uploadName, "demo.txt");
    assert.equal(messages.length, 1);
    assert.equal(messages[0].receiveId, "oc_test_chat");
    assert.equal(messages[0].receiveIdType, "chat_id");
    assert.equal(messages[0].fileKey, "file-success");
    assert.equal(fallbackCalled, false);
  });
});

test("sendFileFromFile retries with a zip wrapper when Feishu rejects the original binary", { concurrency: false }, async () => {
  await withTempFile("app-release.apk", Buffer.from("apk-binary"), async (filePath) => {
    const uploads = [];
    const messages = [];
    let cleanupCalled = false;
    let attempt = 0;

    const result = await sendFileFromFile("oc_test_chat", filePath, {
      uploadFile: async (uploadPath, uploadName) => {
        uploads.push({ uploadPath, uploadName });
        attempt += 1;
        if (attempt === 1) {
          const error = new Error("Request failed with status code 400");
          error.response = {
            status: 400,
            data: "Error when parsing request"
          };
          throw error;
        }
        return { fileKey: "file-zipped" };
      },
      sendMessage: async (payload) => {
        messages.push(payload);
      },
      createZipFallback: async (originalPath) => {
        assert.equal(originalPath, path.resolve(filePath));
        return {
          archivePath: `${originalPath}.zip`,
          uploadName: "app-release.apk.zip",
          cleanup() {
            cleanupCalled = true;
          }
        };
      }
    });

    assert.equal(result.fallbackUsed, true);
    assert.equal(result.uploadName, "app-release.apk.zip");
    assert.equal(uploads.length, 2);
    assert.equal(uploads[0].uploadName, "app-release.apk");
    assert.equal(uploads[1].uploadName, "app-release.apk.zip");
    assert.equal(messages.length, 1);
    assert.equal(messages[0].fileKey, "file-zipped");
    assert.equal(cleanupCalled, true);
  });
});
