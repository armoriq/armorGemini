// ArmorGemini config resolver.
//
// v0.3 adds intent-plan enforcement: the plugin bundles an MCP server that
// exposes register_intent_plan, and the engine denies any tool call that
// isn't in the currently registered plan (drift check).
//
// Behavior remains fail-closed when the plugin isn't configured with an
// ArmorIQ API key. Everything else is a tested-good default; env vars are
// dev/CI escape hatches, not end-user surface.
//
// Credential resolution precedence (matches ArmorClaude / ArmorCodex):
//   1. Environment variable ARMORIQ_API_KEY (dev override)
//   2. Environment variable ARMORGEMINI_API_KEY (product-specific override)
//   3. ~/.armoriq/credentials.json written by `armoriq login`

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const DEFAULT_BACKEND = "https://api.armoriq.ai";
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_DATA_DIR = path.join(homedir(), ".gemini", "armorgemini");
// A plan older than this is treated as stale; the next BeforeTool will
// deny with "plan expired, re-plan required." Keeps the token semantics
// consistent with ArmorClaude's default.
const DEFAULT_PLAN_TTL_SECONDS = 600;

function readCredentialsFile() {
  // Escape hatch used only by the unit tests: allows the test runner to
  // ignore the developer machine's actual ~/.armoriq/credentials.json so
  // fail-closed assertions do not accidentally see a configured plugin.
  // End users never touch this env var.
  if (process.env.ARMORGEMINI_SKIP_CREDS_FILE === "1") return null;
  const file = path.join(homedir(), ".armoriq", "credentials.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

function envBoolean(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  return /^(1|true|yes|on)$/i.test(raw);
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

  const dataDir = process.env.ARMORGEMINI_DATA_DIR || DEFAULT_DATA_DIR;

  // Intent-plan enforcement is on by default in v0.3. Set
  // ARMORGEMINI_INTENT_REQUIRED=false to fall back to policy-only mode
  // (equivalent to v0.2 behavior) while an operator is migrating.
  const intentRequired = envBoolean("ARMORGEMINI_INTENT_REQUIRED", true);

  const planTtlSeconds = Number.parseInt(
    process.env.ARMORGEMINI_PLAN_TTL_SECONDS || "",
    10
  );

  return {
    apiKey,
    backendEndpoint,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
    orgId,
    dataDir,
    intentRequired,
    planTtlSeconds: Number.isFinite(planTtlSeconds) && planTtlSeconds > 0 ? planTtlSeconds : DEFAULT_PLAN_TTL_SECONDS,
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
    "X-ArmorIQ-Client": "armorgemini/0.3.0"
  };
}
