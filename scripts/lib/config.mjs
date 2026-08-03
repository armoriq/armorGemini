// ArmorGemini config resolver.
// ArmorGemini is BACKEND-ONLY: no local policy or audit fallbacks.
// If the API key or backend endpoint is missing, the plugin fails closed
// (denies every tool call with a clear "not configured" message).

const DEFAULT_BACKEND = "https://api.armoriq.ai";
const DEFAULT_TIMEOUT_MS = 8000;

export function loadConfig() {
  const apiKey =
    process.env.ARMORIQ_API_KEY ||
    process.env.ARMORGEMINI_API_KEY ||
    "";

  const backendEndpoint = (
    process.env.ARMORIQ_BACKEND_ENDPOINT ||
    process.env.ARMORGEMINI_BACKEND_ENDPOINT ||
    DEFAULT_BACKEND
  ).replace(/\/+$/, "");

  const timeoutMs = Number.parseInt(
    process.env.ARMORGEMINI_TIMEOUT_MS || "",
    10
  );

  const orgId = process.env.ARMORIQ_ORG_ID || undefined;

  return {
    apiKey,
    backendEndpoint,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
    orgId,
    isConfigured: Boolean(apiKey && backendEndpoint)
  };
}

export function authHeaders(config) {
  return {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "Authorization": `Bearer ${config.apiKey}`,
    "X-ArmorIQ-Client": "armorgemini/0.2.0"
  };
}
