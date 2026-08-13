// ArmorGemini engine (backend-only).
// Every enforcement decision and every audit record flows through the
// ArmorIQ IAP backend. If the plugin is not configured (missing API key),
// hooks fail closed: every tool call is denied with a "not configured" reason.

import { loadConfig } from "./config.mjs";
import { verifyStep, sendAudit } from "./backend-client.mjs";
import { writeLog } from "./hook-io.mjs";

function sanitizeInput(input) {
  const denyKeys = /(password|token|secret|api[_-]?key|authorization)/i;
  const out = {};
  for (const [k, v] of Object.entries(input || {})) {
    if (denyKeys.test(k)) out[k] = "***redacted***";
    else if (typeof v === "string" && v.length > 800) out[k] = v.slice(0, 800) + `…(+${v.length - 800} chars)`;
    else out[k] = v;
  }
  return out;
}

function notConfiguredDecision() {
  return {
    decision: "deny",
    reason:
      "ArmorGemini is not connected to an ArmorIQ account yet. Run `armoriq login --product armorgemini` " +
      "in a terminal to authenticate (it opens the browser and writes ~/.armoriq/credentials.json). " +
      "If you have not installed the plugin yet: `curl -fsSL https://armoriq.ai/install_armorgemini.sh | bash`.",
    systemMessage: "🛡️ ArmorGemini not connected - run `armoriq login`"
  };
}

export async function onSessionStart(payload) {
  const config = loadConfig();
  writeLog(
    `SessionStart session=${payload?.session_id || "?"} cwd=${payload?.cwd || "?"} configured=${config.isConfigured}`
  );
  if (!config.isConfigured) {
    return {
      systemMessage:
        "🛡️ ArmorGemini not connected. Run `armoriq login --product armorgemini` to enable enforcement."
    };
  }
  return {
    systemMessage:
      "🛡️ ArmorGemini active (ENFORCING). Every tool call is checked against your ArmorIQ policy."
  };
}

export async function onSessionEnd(payload) {
  writeLog(`SessionEnd session=${payload?.session_id || "?"}`);
  return {};
}

export async function onBeforeTool(payload) {
  const config = loadConfig();
  if (!config.isConfigured) {
    writeLog(
      `DENY ${payload?.tool_name || "?"} - plugin not configured (missing ARMORIQ_API_KEY)`
    );
    return notConfiguredDecision();
  }

  const toolName = payload?.tool_name || "";
  const toolInput = payload?.tool_input || {};
  const sessionId = payload?.session_id || "";
  const description = typeof toolInput.description === "string" ? toolInput.description : undefined;

  const verdict = await verifyStep(config, {
    sessionId,
    toolName,
    toolInput,
    description
  });

  if (verdict.fatal) {
    writeLog(`FATAL DENY ${toolName} - ${verdict.reason}`);
    return {
      decision: "deny",
      reason: verdict.reason,
      systemMessage: "🛡️ ArmorGemini fatal auth error"
    };
  }

  if (!verdict.allowed) {
    writeLog(`DENY ${toolName} - ${verdict.reason}`);
    return {
      decision: "deny",
      reason: verdict.reason || `Denied by ArmorIQ policy`,
      systemMessage: `🛡️ ArmorGemini blocked ${toolName}`
    };
  }

  writeLog(`ALLOW ${toolName}`);
  return {
    decision: "allow",
    systemMessage: verdict.matchedPolicy
      ? `🛡️ ArmorGemini: ${toolName} allowed (rule: ${verdict.matchedPolicy.name || verdict.matchedPolicy.id || "matched"})`
      : `🛡️ ArmorGemini: ${toolName} allowed (no matching policy)`
  };
}

export async function onAfterTool(payload) {
  const config = loadConfig();
  if (!config.isConfigured) return {};

  const toolName = payload?.tool_name || "";
  const sessionId = payload?.session_id || "";
  const summary =
    payload?.tool_response?.returnDisplay?.summary ||
    (payload?.tool_response?.llmContent ? String(payload.tool_response.llmContent).slice(0, 200) : "");

  const res = await sendAudit(config, {
    event: "AfterTool",
    at: new Date().toISOString(),
    session_id: sessionId,
    tool_name: toolName,
    tool_input: sanitizeInput(payload?.tool_input || {}),
    result_summary: summary
  });

  writeLog(`Audit ${toolName} sent (ok=${res.ok})`);
  return {};
}
