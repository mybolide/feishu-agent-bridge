export function resolveBoundSessionForRun({ sessionId, runtimeId = "", unhealthy = false } = {}) {
  const activeSession = String(sessionId || "").trim();
  if (!activeSession) {
    return "";
  }
  if (String(runtimeId || "").trim().toLowerCase() === "iflow-cli" && unhealthy) {
    return "";
  }
  return activeSession;
}
