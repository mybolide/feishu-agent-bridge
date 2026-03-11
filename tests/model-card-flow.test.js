import test from "node:test";
import assert from "node:assert/strict";
import { showModelCardFlow } from "../gateway/feishu/core/model-card-flow.js";

function createDispatchRecorder(returnMessageId = "msg-loading-1") {
  const calls = [];
  let count = 0;
  const dispatchInteractiveCard = async (chatId, card, options = {}) => {
    calls.push({ chatId, card, options });
    count += 1;
    if (count === 1) {
      return { mode: "sent", messageId: returnMessageId };
    }
    return { mode: "updated", messageId: String(options?.messageId || returnMessageId) };
  };
  return { calls, dispatchInteractiveCard };
}

test("showModelCardFlow sends loading then updates with model card", async () => {
  const { calls, dispatchInteractiveCard } = createDispatchRecorder();
  let listCalls = 0;
  await showModelCardFlow("chat-a", {
    getSelectedTool: () => "iflow-cli",
    getProvider: () => ({
      id: "iflow-cli",
      label: "iFlow CLI",
      model: {
        list: async (forceRefresh) => {
          listCalls += 1;
          assert.equal(forceRefresh, true);
          return ["iflow-cli/glm-5", "iflow-cli/qwen3-coder-plus"];
        }
      }
    }),
    getCurrentModel: () => "iflow-cli/glm-5",
    buildModelCard: (current, models) => ({ kind: "model_card", current, models }),
    dispatchInteractiveCard
  });

  assert.equal(listCalls, 1);
  assert.equal(calls.length, 2);
  assert.match(JSON.stringify(calls[0].card), /模型加载中/);
  assert.equal(calls[1].options.messageId, "msg-loading-1");
  assert.equal(calls[1].card.kind, "model_card");
});

test("showModelCardFlow updates warning card when no models", async () => {
  const { calls, dispatchInteractiveCard } = createDispatchRecorder("msg-loading-empty");
  await showModelCardFlow("chat-b", {
    getSelectedTool: () => "iflow-cli",
    getProvider: () => ({
      id: "iflow-cli",
      label: "iFlow CLI",
      model: {
        list: async () => []
      }
    }),
    getCurrentModel: () => "",
    buildModelCard: () => ({ kind: "should_not_use" }),
    dispatchInteractiveCard
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.messageId, "msg-loading-empty");
  assert.match(JSON.stringify(calls[1].card), /暂无可用模型/);
});

test("showModelCardFlow updates error card when model list throws", async () => {
  const { calls, dispatchInteractiveCard } = createDispatchRecorder("msg-loading-error");
  await showModelCardFlow("chat-c", {
    getSelectedTool: () => "iflow-cli",
    getProvider: () => ({
      id: "iflow-cli",
      label: "iFlow CLI",
      model: {
        list: async () => {
          throw new Error("timeout");
        }
      }
    }),
    getCurrentModel: () => "",
    buildModelCard: () => ({ kind: "should_not_use" }),
    dispatchInteractiveCard
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.messageId, "msg-loading-error");
  assert.match(JSON.stringify(calls[1].card), /获取模型失败/);
});
