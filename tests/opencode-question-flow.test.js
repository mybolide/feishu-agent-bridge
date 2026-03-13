import test from "node:test";
import assert from "node:assert/strict";
import { buildQuestionReplyAnswers, findLatestPendingQuestionRequest } from "../gateway/agent-runtime/opencode/client.js";
import { MESSAGE_POLL_TIMEOUT_MS, WAIT_FOREVER_AFTER_PROGRESS } from "../gateway/agent-runtime/opencode/client-core.js";
import { computeAssistantWaitDeadline, extractTextFromParts, formatQuestionRequestText, readLatestAssistantResponse } from "../gateway/agent-runtime/opencode/message-reader.js";

test("formatQuestionRequestText renders numbered questions and options", () => {
  const text = formatQuestionRequestText({
    id: "req-1",
    sessionID: "session-1",
    questions: [
      {
        header: "目标用户",
        question: "这套系统主要给谁用？",
        options: [
          { label: "创作者", description: "面向内容创作者" },
          { label: "运营", description: "面向运营团队" }
        ]
      }
    ]
  });

  assert.match(text, /1\. 目标用户: 这套系统主要给谁用？/);
  assert.match(text, /选项: 创作者 \/ 运营/);
});

test("readLatestAssistantResponse waits for completion when only partial assistant text exists", () => {
  const snapshot = readLatestAssistantResponse([
    {
      info: {
        id: "msg-1",
        role: "assistant",
        time: { created: 100 },
      },
      parts: [
        { type: "text", text: "在开始之前，我需要澄清几个关键问题：" }
      ]
    }
  ], [], "session-1", 0, new Set(), new Set());

  assert.equal(snapshot.completed, false);
  assert.equal(snapshot.hasQuestion, false);
  assert.match(snapshot.text, /澄清几个关键问题/);
});

test("readLatestAssistantResponse returns question text when opencode emits question request", () => {
  const snapshot = readLatestAssistantResponse([
    {
      info: {
        id: "msg-2",
        role: "assistant",
        time: { created: 200 },
      },
      parts: [
        { type: "text", text: "明白了。你是要我帮你从零搭建这个视频创作自动化流水线。\n\n在开始之前，我需要澄清几个关键问题，以确保我交付的东西是你真正需要的：" }
      ]
    }
  ], [
    {
      id: "req-2",
      sessionID: "session-1",
      questions: [
        {
          header: "交付形式",
          question: "你希望最终交付的是脚本、服务还是完整工作流？",
          options: [
            { label: "脚本", description: "偏轻量" },
            { label: "完整工作流", description: "端到端" }
          ]
        },
        {
          header: "部署位置",
          question: "这套系统计划跑在本地还是服务器？",
          options: [
            { label: "本地", description: "单机运行" },
            { label: "服务器", description: "集中部署" }
          ]
        }
      ]
    }
  ], "session-1", 0, new Set(), new Set());

  assert.equal(snapshot.completed, true);
  assert.equal(snapshot.hasQuestion, true);
  assert.match(snapshot.text, /明白了。你是要我帮你从零搭建这个视频创作自动化流水线。/);
  assert.match(snapshot.text, /1\. 交付形式: 你希望最终交付的是脚本、服务还是完整工作流？/);
  assert.match(snapshot.text, /2\. 部署位置: 这套系统计划跑在本地还是服务器？/);
});

test("readLatestAssistantResponse prefers the latest completed assistant text over a newer empty unfinished message", () => {
  const snapshot = readLatestAssistantResponse([
    {
      info: {
        id: "msg-completed",
        role: "assistant",
        time: { created: 300, completed: 320 }
      },
      parts: [
        { type: "text", text: "现在开始搭建项目。" }
      ]
    },
    {
      info: {
        id: "msg-empty",
        role: "assistant",
        time: { created: 330 }
      },
      parts: [
        { type: "step-start" },
        { type: "reasoning", text: "" }
      ]
    }
  ], [], "session-1", 0, new Set(), new Set());

  assert.equal(snapshot.completed, true);
  assert.equal(snapshot.hasQuestion, false);
  assert.match(snapshot.text, /现在开始搭建项目/);
});

test("readLatestAssistantResponse keeps waiting when assistant completed with tool-calls", () => {
  const snapshot = readLatestAssistantResponse([
    {
      info: {
        id: "msg-tools",
        role: "assistant",
        finish: "tool-calls",
        time: { created: 340, completed: 360 }
      },
      parts: [
        { type: "text", text: "没有卡，正在继续创建模块。加快速度：" },
        {
          type: "tool",
          tool: "write",
          state: {
            status: "completed",
            title: "src/modules/download/index.js"
          }
        }
      ]
    }
  ], [], "session-1", 0, new Set(), new Set());

  assert.equal(snapshot.completed, false);
  assert.equal(snapshot.messageCompleted, true);
  assert.equal(snapshot.messageTerminal, false);
  assert.equal(snapshot.messageFinish, "tool-calls");
  assert.match(snapshot.text, /src\/modules\/download\/index\.js/);
});

test("readLatestAssistantResponse returns final stop message after tool work completes", () => {
  const snapshot = readLatestAssistantResponse([
    {
      info: {
        id: "msg-tools",
        role: "assistant",
        finish: "tool-calls",
        time: { created: 340, completed: 360 }
      },
      parts: [
        { type: "text", text: "没有卡，正在继续创建模块。加快速度：" }
      ]
    },
    {
      info: {
        id: "msg-final",
        role: "assistant",
        finish: "stop",
        time: { created: 370, completed: 420 }
      },
      parts: [
        { type: "text", text: "模块已经创建完成，接下来开始联调。" }
      ]
    }
  ], [], "session-1", 0, new Set(), new Set());

  assert.equal(snapshot.completed, true);
  assert.equal(snapshot.messageTerminal, true);
  assert.equal(snapshot.messageFinish, "stop");
  assert.match(snapshot.text, /模块已经创建完成/);
});

test("readLatestAssistantResponse completes when stop message text is visible before completedAt is written", () => {
  const snapshot = readLatestAssistantResponse([
    {
      info: {
        id: "msg-tools",
        role: "assistant",
        finish: "tool-calls",
        time: { created: 430, completed: 460 }
      },
      parts: [
        {
          type: "tool",
          tool: "bash",
          state: {
            status: "completed",
            title: "Convert to mp4"
          }
        }
      ]
    },
    {
      info: {
        id: "msg-stop-visible",
        role: "assistant",
        finish: "stop",
        time: { created: 470 }
      },
      parts: [
        { type: "text", text: "✅ 已完成，成品已经生成。" }
      ]
    }
  ], [], "session-1", 0, new Set(), new Set());

  assert.equal(snapshot.completed, true);
  assert.equal(snapshot.messageCompleted, false);
  assert.equal(snapshot.messageTerminal, true);
  assert.equal(snapshot.messageFinish, "stop");
  assert.match(snapshot.text, /成品已经生成/);
});

test("readLatestAssistantResponse completes when terminal assistant has no text but previous tool step is visible", () => {
  const snapshot = readLatestAssistantResponse([
    {
      info: {
        id: "msg-tools",
        role: "assistant",
        finish: "tool-calls",
        time: { created: 430, completed: 460 }
      },
      parts: [
        {
          type: "tool",
          tool: "edit",
          state: {
            status: "completed",
            title: "src/generate_solar.js"
          }
        }
      ]
    },
    {
      info: {
        id: "msg-final",
        role: "assistant",
        finish: "stop",
        time: { created: 470, completed: 490 }
      },
      parts: [
        { type: "step-start" },
        { type: "reasoning", text: "已完成调整。" },
        { type: "step-finish" }
      ]
    }
  ], [], "session-1", 0, new Set(), new Set());

  assert.equal(snapshot.completed, true);
  assert.equal(snapshot.messageTerminal, true);
  assert.match(snapshot.text, /已完成调整/);
});

test("readLatestAssistantResponse returns reasoning text when terminal assistant has no user text", () => {
  const snapshot = readLatestAssistantResponse([
    {
      info: {
        id: "msg-final",
        role: "assistant",
        finish: "stop",
        time: { created: 500, completed: 520 }
      },
      parts: [
        { type: "step-start" },
        { type: "reasoning", text: "已完成调整。" },
        { type: "step-finish" }
      ]
    }
  ], [], "session-1", 0, new Set(), new Set());

  assert.equal(snapshot.completed, true);
  assert.equal(snapshot.messageTerminal, true);
  assert.equal(snapshot.text, "已完成调整。");
});

test("computeAssistantWaitDeadline uses base timeout before any progress", () => {
  const startedAt = 1000;
  const deadline = computeAssistantWaitDeadline(startedAt, null, null);
  assert.equal(deadline, startedAt + MESSAGE_POLL_TIMEOUT_MS);
});

test("computeAssistantWaitDeadline extends by stall timeout after progress", () => {
  const startedAt = 1000;
  const progressState = {
    firstProgressAt: 4000,
    lastProgressAt: 9000
  };
  const activityState = {
    lastObservedAt: 12000
  };
  const deadline = computeAssistantWaitDeadline(startedAt, progressState, activityState);
  const expected = WAIT_FOREVER_AFTER_PROGRESS
    ? Number.POSITIVE_INFINITY
    : Math.max(startedAt + MESSAGE_POLL_TIMEOUT_MS, 12000 + MESSAGE_POLL_TIMEOUT_MS);
  assert.equal(deadline, expected);
});

test("readLatestAssistantResponse returns empty text when terminal assistant finishes with error and no text", () => {
  const snapshot = readLatestAssistantResponse([
    {
      info: {
        id: "msg-error",
        role: "assistant",
        finish: "error",
        time: { created: 600, completed: 620 }
      },
      parts: [
        { type: "step-start" },
        { type: "step-finish" }
      ]
    }
  ], [], "session-1", 0, new Set(), new Set());

  assert.equal(snapshot.completed, true);
  assert.equal(snapshot.messageTerminal, true);
  assert.equal(snapshot.messageFinish, "error");
  assert.equal(snapshot.text, "");
});

test("extractTextFromParts appends raw tool text after assistant text", () => {
  const text = extractTextFromParts([
    { type: "text", text: "没有卡，正在继续创建模块。加快速度：" },
    {
      type: "tool",
      tool: "write",
      state: {
        status: "completed",
        title: "src/modules/download/index.js"
      }
    }
  ]);

  assert.match(text, /没有卡，正在继续创建模块。加快速度：/);
  assert.match(text, /src\/modules\/download\/index\.js/);
});

test("extractTextFromParts includes text and tool text without extra wrapping", () => {
  const text = extractTextFromParts([
    { type: "text", text: "现在开始搭建项目。" },
    {
      type: "tool",
      tool: "write",
      state: {
        status: "completed",
        title: "src/modules/download/index.js"
      }
    }
  ]);

  assert.equal(text, "现在开始搭建项目。\n\nsrc/modules/download/index.js");
});

test("extractTextFromParts includes grep input and output when no assistant text exists", () => {
  const text = extractTextFromParts([
    {
      type: "tool",
      tool: "grep",
      state: {
        status: "completed",
        input: {
          include: "*.js",
          output_mode: "content",
          path: "E:\\zimeiti\\yumoxingchen\\src",
          pattern: "duration.*15"
        },
        output: "Found 1 match(es) in 1 file(s)\n\nE:\\zimeiti\\yumoxingchen\\src\\index.js\n  30: duration: 15, // 秒\n"
      }
    }
  ]);

  assert.match(text, /E:\\zimeiti\\yumoxingchen\\src/);
  assert.match(text, /Found 1 match/);
  assert.match(text, /duration: 15/);
});

test("extractTextFromParts includes reasoning text as-is", () => {
  const text = extractTextFromParts([
    { type: "reasoning", text: "先检查目录状态。" },
    { type: "text", text: "开始处理。" }
  ]);

  assert.equal(text, "先检查目录状态。\n\n开始处理。");
});

test("findLatestPendingQuestionRequest picks the latest request in the same session", () => {
  const pending = findLatestPendingQuestionRequest([
    { id: "req-1", sessionID: "session-a", questions: [{ question: "old" }] },
    { id: "req-2", sessionID: "session-b", questions: [{ question: "other" }] },
    { id: "req-3", sessionID: "session-a", questions: [{ question: "latest" }] }
  ], "session-a");

  assert.equal(pending?.id, "req-3");
});

test("buildQuestionReplyAnswers uses freeform reply for a single custom question", () => {
  const answers = buildQuestionReplyAnswers({
    questions: [
      {
        header: "补充说明",
        question: "还有什么补充？",
        custom: true,
        options: []
      }
    ]
  }, "这个是操控浏览器下载，不用api");

  assert.deepEqual(answers, [["这个是操控浏览器下载，不用api"]]);
});

test("buildQuestionReplyAnswers returns null when multi-question reply cannot be mapped", () => {
  const answers = buildQuestionReplyAnswers({
    questions: [
      {
        header: "编程语言",
        question: "你想用什么编程语言？",
        options: [{ label: "Node.js" }, { label: "Python" }]
      },
      {
        header: "视频类型",
        question: "主要做什么类型的视频？",
        options: [{ label: "壁纸/风景类" }, { label: "科普/解说类" }]
      }
    ]
  }, "这个是操控浏览器下载，不用api");

  assert.equal(answers, null);
});
