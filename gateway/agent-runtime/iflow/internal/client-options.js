import { REQUEST_TIMEOUT_MS } from "./common.js";

function resolveAuthMethodInfo() {
  const apiKey = String(process.env.IFLOW_API_KEY || "").trim();
  const baseUrl = String(process.env.IFLOW_BASE_URL || "").trim();
  const modelName = String(process.env.IFLOW_MODEL_NAME || "").trim();
  const info = {};
  if (apiKey) {
    info.apiKey = apiKey;
  }
  if (baseUrl) {
    info.baseUrl = baseUrl;
  }
  if (modelName) {
    info.modelName = modelName;
  }
  return Object.keys(info).length > 0 ? info : undefined;
}

export function createClientOptions(directory, sessionId = "") {
  return {
    cwd: directory,
    sessionId: sessionId || undefined,
    autoStartProcess: true,
    stream: true,
    permissionMode: "auto",
    timeout: REQUEST_TIMEOUT_MS,
    transportMode: String(process.env.IFLOW_TRANSPORT_MODE || "").trim() || undefined,
    iflowPath: String(process.env.IFLOW_PATH || "").trim() || undefined,
    authMethodId: String(process.env.IFLOW_AUTH_METHOD_ID || "").trim() || undefined,
    authMethodInfo: resolveAuthMethodInfo()
  };
}
