import test from "node:test";
import assert from "node:assert/strict";
import { buildModelCard } from "../gateway/feishu/ui/cards.js";

function collectActionLabels(card) {
  const labels = [];
  for (const element of (card?.elements || [])) {
    if (element?.tag !== "action" || !Array.isArray(element.actions)) {
      continue;
    }
    for (const action of element.actions) {
      labels.push(String(action?.text?.content || "").trim());
    }
  }
  return labels.filter(Boolean);
}

test("buildModelCard should render more than 12 models by pagination size", () => {
  const models = Array.from({ length: 40 }, (_, idx) => `provider/model-${idx + 1}`);
  const card = buildModelCard("provider/model-1", models, 0);
  const labels = collectActionLabels(card);
  const modelButtons = labels.filter((item) => item.startsWith("provider/model-"));
  assert.equal(modelButtons.length, 24);
  assert.ok(labels.includes("下一页 ➡️"));
});

test("buildModelCard should include previous page action when page > 0", () => {
  const models = Array.from({ length: 60 }, (_, idx) => `provider/model-${idx + 1}`);
  const card = buildModelCard("provider/model-1", models, 1);
  const labels = collectActionLabels(card);
  assert.ok(labels.includes("⬅️ 上一页"));
  assert.ok(labels.includes("下一页 ➡️"));
});
