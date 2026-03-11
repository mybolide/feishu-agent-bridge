function normalizeRuntimeId(runtimeId) {
  return String(runtimeId || "").trim().toLowerCase();
}

export function normalizeModelList(models) {
  if (!Array.isArray(models)) {
    return [];
  }
  const seen = new Set();
  const output = [];
  for (const item of models) {
    const value = String(item || "").trim();
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    output.push(value);
  }
  return output;
}

export function pickPreferredModel(runtimeId, models) {
  const runtime = normalizeRuntimeId(runtimeId);
  const rows = normalizeModelList(models);
  if (rows.length === 0) {
    return "";
  }

  if (runtime === "opencode") {
    const preferredPrefixes = ["code3/", "code4/", "opencode/"];
    for (const prefix of preferredPrefixes) {
      const hit = rows.find((item) => item.startsWith(prefix));
      if (hit) {
        return hit;
      }
    }
  }

  if (runtime === "iflow-cli") {
    const hit = rows.find((item) => item.startsWith("iflow-cli/"));
    if (hit) {
      return hit;
    }
  }

  return rows[0];
}

export function resolveRequestedModel({
  runtimeId,
  requestedModel,
  availableModels,
  preferWhenEmpty = false
}) {
  const runtime = normalizeRuntimeId(runtimeId);
  const requested = String(requestedModel || "").trim();
  const rows = normalizeModelList(availableModels);

  if (requested && rows.includes(requested)) {
    return {
      runtimeId: runtime,
      requestedModel: requested,
      model: requested,
      changed: false,
      reason: "matched"
    };
  }

  const fallback = pickPreferredModel(runtime, rows);

  if (requested) {
    return {
      runtimeId: runtime,
      requestedModel: requested,
      model: fallback,
      changed: fallback !== requested,
      reason: "requested_unavailable"
    };
  }

  if (preferWhenEmpty) {
    return {
      runtimeId: runtime,
      requestedModel: "",
      model: fallback,
      changed: Boolean(fallback),
      reason: "default_selected"
    };
  }

  return {
    runtimeId: runtime,
    requestedModel: "",
    model: "",
    changed: false,
    reason: "empty"
  };
}
