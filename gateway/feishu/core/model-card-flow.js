function buildStatusCard(title, content, template = "blue") {
  return {
    header: {
      template,
      title: { tag: "plain_text", content: title }
    },
    elements: [
      {
        tag: "div",
        text: { tag: "lark_md", content }
      }
    ]
  };
}

function buildLoadingCard(providerLabel) {
  const label = String(providerLabel || "当前工具").trim();
  return buildStatusCard("模型加载中", `⏳ 正在获取 **${label}** 的模型列表，请稍候...`);
}

function buildWarnCard(providerId, message) {
  const detail = String(message || "").trim();
  return buildStatusCard(
    "模型列表不可用",
    `⚠️ 工具 \`${String(providerId || "").trim() || "unknown"}\` ${detail || "暂无可用模型，请检查配置。"}`,
    "orange"
  );
}

function buildErrorCard(providerId, errorMessage) {
  const detail = String(errorMessage || "").trim() || "unknown error";
  return buildStatusCard(
    "模型列表获取失败",
    `❌ 工具 \`${String(providerId || "").trim() || "unknown"}\` 获取模型失败：${detail}`,
    "red"
  );
}

export async function showModelCardFlow(chatId, deps, options = {}) {
  const page = Math.max(0, Number.parseInt(String(options?.page ?? 0), 10) || 0);
  const forceRefresh = options?.forceRefresh === undefined ? page === 0 : Boolean(options.forceRefresh);
  const getSelectedTool = deps?.getSelectedTool;
  const getProvider = deps?.getProvider;
  const getCurrentModel = deps?.getCurrentModel;
  const buildModelCard = deps?.buildModelCard;
  const dispatchInteractiveCard = deps?.dispatchInteractiveCard;

  if (typeof getSelectedTool !== "function"
    || typeof getProvider !== "function"
    || typeof getCurrentModel !== "function"
    || typeof buildModelCard !== "function"
    || typeof dispatchInteractiveCard !== "function") {
    throw new Error("showModelCardFlow dependencies are incomplete");
  }

  const selectedTool = String(getSelectedTool(chatId) || "").trim();
  const provider = getProvider(selectedTool);
  const providerId = String(provider?.id || selectedTool || "").trim();
  const providerLabel = String(provider?.label || providerId || "当前工具").trim();

  if (!provider?.model || typeof provider.model.list !== "function") {
    await dispatchInteractiveCard(chatId, buildWarnCard(providerId, "暂不支持模型切换。"), {
      allowFallbackSend: true
    });
    return;
  }

  const loading = await dispatchInteractiveCard(chatId, buildLoadingCard(providerLabel), {
    allowFallbackSend: true
  });
  const messageId = String(loading?.messageId || "").trim();

  try {
    const models = await provider.model.list(forceRefresh);
    if (!Array.isArray(models) || models.length === 0) {
      await dispatchInteractiveCard(chatId, buildWarnCard(providerId, "暂无可用模型，请检查配置。"), {
        messageId,
        allowFallbackSend: true
      });
      return;
    }
    const current = String(getCurrentModel(chatId) || "").trim() || String(models[0] || "").trim();
    await dispatchInteractiveCard(chatId, buildModelCard(current, models, page), {
      messageId,
      allowFallbackSend: true
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await dispatchInteractiveCard(chatId, buildErrorCard(providerId, message), {
      messageId,
      allowFallbackSend: true
    });
  }
}
