// ArmorGemini config resolver.
//
// ArmorGemini is BACKEND-ONLY. There is no local policy or audit fallback.
// If the plugin is not configured (missing API key), hooks fail closed and
// every tool call is denied with a clear message pointing the user at the
// installer's `armoriq login` step.
//
// Credential resolution precedence (matches ArmorClaude / ArmorCodex):
//   1. Environment variable ARMORIQ_API_KEY (dev override)
//   2. Environment variable ARMORGEMINI_API_KEY (product-specific override)
//   3. ~/.armoriq/credentials.json written by `armoriq login`
//
// End users never touch env vars. The installer runs `armoriq login
// --product armorgemini` which opens the browser, mints a key, and writes
// credentials.json. The plugin picks it up automatically from run to run.

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const DEFAULT_BACKEND = "https://api.armoriq.ai";
const DEFAULT_TIMEOUT_MS = 8000;

function readCredentialsFile() {
  const file = path.join(homedir(), ".armoriq", "credentials.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

export function loadConfig() {
  const creds = readCredentialsFile();

  const apiKey =
    process.env.ARMORIQ_API_KEY ||
    process.env.ARMORGEMINI_API_KEY ||
    (typeof creds?.apiKey === "string" ? creds.apiKey : "") ||
    "";

  const backendEndpoint = (
    process.env.ARMORIQ_BACKEND_ENDPOINT ||
    process.env.ARMORGEMINI_BACKEND_ENDPOINT ||
    (typeof creds?.backendEndpoint === "string" ? creds.backendEndpoint : "") ||
    DEFAULT_BACKEND
  ).replace(/\/+$/, "");

  const timeoutMs = Number.parseInt(
    process.env.ARMORGEMINI_TIMEOUT_MS || "",
    10
  );

  const orgId =
    process.env.ARMORIQ_ORG_ID ||
    (typeof creds?.orgId === "string" ? creds.orgId : "") ||
    undefined;

  return {
    apiKey,
    backendEndpoint,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
    orgId,
    credentialSource: apiKey
      ? process.env.ARMORIQ_API_KEY || process.env.ARMORGEMINI_API_KEY
        ? "env"
        : "credentials.json"
      : "none",
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
