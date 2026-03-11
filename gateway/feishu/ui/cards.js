function normalizeMarkdownForFeishu(text) {
  let value = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!value) {
    return "(无输出)";
  }
  const fenceCount = (value.match(/```/g) || []).length;
  if (fenceCount % 2 === 1) {
    value += "\n```";
  }
  value = value.replace(/\n{3,}/g, "\n\n");
  return value;
}

function buildMarkdownCard(markdown, title = "") {
  const body = {
    schema: "2.0",
    config: { wide_screen_mode: true },
    body: {
      elements: [{ tag: "markdown", content: markdown }]
    }
  };
  if (title) {
    body.header = {
      title: { tag: "plain_text", content: title }
    };
  }
  return body;
}

export function shouldRenderResultAsMarkdownCard(taskOutput) {
  const text = String(taskOutput || "").replace(/\r\n/g, "\n").trim();
  if (!text) {
    return false;
  }
  if (/```/.test(text)) {
    return true;
  }
  if (/^#{1,6}\s/m.test(text)) {
    return true;
  }
  if (/^\s*[-*+]\s+/m.test(text)) {
    return true;
  }
  if (/^\s*\d+\.\s+/m.test(text)) {
    return true;
  }
  if (/\[[^\]]+\]\([^\)]+\)/.test(text)) {
    return true;
  }
  if (/^>\s+/m.test(text)) {
    return true;
  }
  if (/\|.+\|/.test(text)) {
    return true;
  }
  if (/\*\*[^*]+\*\*/.test(text) || /__[^_]+__/.test(text)) {
    return true;
  }
  return false;
}

export function buildTaskResultNavigatorCard(targetPath, taskOutput, taskFeedback = {}) {
  const _ignored = { targetPath, taskFeedback };
  void _ignored;
  const preview = String(taskOutput || "").trim() || "(无输出)";
  const cardContent = preview.length > 5000 ? `${preview.slice(0, 5000)}\n\n...(已截断)` : preview;
  return buildMarkdownCard(normalizeMarkdownForFeishu(cardContent));
}

export function parseTextContent(raw) {
  if (typeof raw !== "string") {
    return "";
  }
  try {
    const parsed = JSON.parse(raw);
    return String(parsed.text || "").trim();
  } catch {
    return "";
  }
}

export function buildModelCard(currentModel, allModels, page = 0) {
  const PAGE_SIZE = 24;
  const models = Array.isArray(allModels) ? allModels : [];
  const total = models.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(Math.max(Number.parseInt(String(page || 0), 10) || 0, 0), totalPages - 1);
  const start = safePage * PAGE_SIZE;
  const end = Math.min(start + PAGE_SIZE, total);
  const options = models.slice(start, end);
  const rows = [];
  for (let i = 0; i < options.length; i += 3) {
    const chunk = options.slice(i, i + 3);
    rows.push({
      tag: "action",
      actions: chunk.map((item) => ({
        tag: "button",
        type: "default",
        text: { tag: "plain_text", content: item },
        value: { action: "change_model", value: item }
      }))
    });
  }
  const pagerActions = [];
  if (safePage > 0) {
    pagerActions.push({
      tag: "button",
      type: "default",
      text: { tag: "plain_text", content: "⬅️ 上一页" },
      value: { action: "change_model_page", page: safePage - 1 }
    });
  }
  if (safePage < (totalPages - 1)) {
    pagerActions.push({
      tag: "button",
      type: "default",
      text: { tag: "plain_text", content: "下一页 ➡️" },
      value: { action: "change_model_page", page: safePage + 1 }
    });
  }
  if (pagerActions.length > 0) {
    rows.push({
      tag: "action",
      actions: pagerActions
    });
  }

  return {
    header: {
      template: "blue",
      title: { tag: "plain_text", content: "选择模型 / Select Model" }
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: `**当前模型 / Current Model**\n${currentModel || "未设置"}\n\n可选模型总数：${total}\n当前页：${safePage + 1}/${totalPages}\n当前展示：${start + 1}-${end}`
        }
      },
      ...rows
    ]
  };
}

export function buildToolCard(currentTool, providers) {
  const options = Array.isArray(providers) ? providers : [];
  const available = options.filter((item) => item?.available);
  const unavailable = options.filter((item) => !item?.available);
  const rows = [];
  for (let i = 0; i < available.length; i += 3) {
    const chunk = available.slice(i, i + 3);
    rows.push({
      tag: "action",
      actions: chunk.map((item) => ({
        tag: "button",
        type: "default",
        text: { tag: "plain_text", content: item.id === currentTool ? `✅ ${item.label}` : item.label },
        value: { action: "change_tool", value: item.id }
      }))
    });
  }
  const unavailableText = unavailable.length > 0
    ? `\n\n不可用工具：${unavailable.map((item) => `${item.label}(${item.id})`).join("、")}`
    : "";
  return {
    header: {
      template: "blue",
      title: { tag: "plain_text", content: "选择工具 / Select Runtime Tool" }
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: `**当前工具 / Current Tool**\n${currentTool || "未设置"}\n\n可用工具：${available.length}${unavailableText}`
        }
      },
      ...rows
    ]
  };
}
