import test from "node:test";
import assert from "node:assert/strict";
import { createOpenCodeProgressCard } from "../gateway/agent-runtime/opencode/progress-card.js";
import { mergeProgressOutput } from "../gateway/server/run-service.js";

test("createOpenCodeProgressCard keeps a single dynamic content area", () => {
  const card = createOpenCodeProgressCard({
    status: "running",
    elapsedSeconds: 12,
    detail: "工作目录：E:\\demo\n\n命令：npm start\n\nFound 1 match",
    latestOutput: "已完成：grep pattern=duration.*15 path=E:\\demo\\src\n输出：\nFound 1 match"
  });

  const elements = Array.isArray(card?.elements) ? card.elements : [];
  const mainBlock = elements.find((item) => item?.text?.content?.includes("命令：npm start"));

  assert.ok(mainBlock);
  assert.match(mainBlock.text.content, /Found 1 match/);
  assert.equal(elements.some((item) => item?.text?.content?.includes("最近动作 / 输出")), false);
});

test("mergeProgressOutput replaces the tail when the same stream grows", () => {
  const merged = mergeProgressOutput("开始处理\n\nabc", "abc", "abcdef");
  assert.equal(merged, "开始处理\n\nabcdef");
});

test("mergeProgressOutput appends when a new output segment arrives", () => {
  const merged = mergeProgressOutput("第一段输出", "第一段输出", "第二段输出");
  assert.equal(merged, "第一段输出\n\n第二段输出");
});
