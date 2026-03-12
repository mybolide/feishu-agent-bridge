export const DEFAULT_OPENCODE_SERVER_URL = "http://127.0.0.1:24096";

export function normalizeOpencodeServerUrl(rawUrl = "") {
  const value = String(rawUrl || "").trim();
  if (!value) {
    return DEFAULT_OPENCODE_SERVER_URL;
  }
  try {
    return new URL(value).toString().replace(/\/$/, "");
  } catch {
    return DEFAULT_OPENCODE_SERVER_URL;
  }
}
