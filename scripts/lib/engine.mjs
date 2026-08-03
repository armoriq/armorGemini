// ArmorGemini core engine. Handles the four Gemini lifecycle events:
//   - SessionStart:  initialize session state
//   - BeforeTool:    policy check + intent verification (enforcement point)
//   - AfterTool:     append audit log
//   - SessionEnd:    session cleanup
//
// Each handler returns the Gemini-shaped decision object.

import { evaluate } from "./policy.mjs";
import { appendAuditLine } from "./fs-store.mjs";
import { writeLog } from "./hook-io.mjs";

export async function onSessionStart(payload) {
  writeLog(`SessionStart: session=${payload?.session_id || "?"} cwd=${payload?.cwd || "?"}`);
  return {};
}

export async function onSessionEnd(payload) {
  writeLog(`SessionEnd: session=${payload?.session_id || "?"}`);
  return {};
}

export async function onBeforeTool(payload) {
  const toolName = payload?.tool_name || "";
  const toolInput = payload?.tool_input || {};
  const session = payload?.session_id || "";

  const result = await evaluate({ toolName, toolInput });

  await appendAuditLine({
    event: "BeforeTool",
    at: new Date().toISOString(),
    session,
    tool: toolName,
    input: sanitize(toolInput),
    verdict: result.verdict,
    rule: result.rule ? { id: result.rule.id, verb: result.rule.verb, target: result.rule.target } : null
  });

  if (result.verdict === "deny") {
    writeLog(`DENY ${toolName} — ${result.reason}`);
    return {
      decision: "deny",
      reason: result.reason,
      systemMessage: `🛡️ ArmorGemini blocked ${toolName}`
    };
  }

  if (result.verdict === "hold") {
    writeLog(`HOLD ${toolName} — ${result.reason}`);
    return {
      decision: "deny",
      reason: `${result.reason} Confirm with the user before retrying.`,
      systemMessage: `⏸️ ArmorGemini held ${toolName} for approval`
    };
  }

  writeLog(`ALLOW ${toolName}`);
  return { decision: "allow" };
}

export async function onAfterTool(payload) {
  const toolName = payload?.tool_name || "";
  const session = payload?.session_id || "";
  const summary =
    payload?.tool_response?.returnDisplay?.summary ||
    (payload?.tool_response?.llmContent ? String(payload.tool_response.llmContent).slice(0, 200) : "");

  await appendAuditLine({
    event: "AfterTool",
    at: new Date().toISOString(),
    session,
    tool: toolName,
    input: sanitize(payload?.tool_input || {}),
    result_summary: summary
  });

  writeLog(`Audited ${toolName}`);
  return {};
}

// Minimal parameter sanitizer. Drops obvious secrets by key name.
// Grows later: full regex-based redaction of common secret shapes.
function sanitize(input) {
  const denyKeys = /(password|token|secret|api[_-]?key|authorization)/i;
  const out = {};
  for (const [k, v] of Object.entries(input || {})) {
    if (denyKeys.test(k)) {
      out[k] = "***redacted***";
    } else if (typeof v === "string" && v.length > 800) {
      out[k] = v.slice(0, 800) + `…(+${v.length - 800} chars)`;
    } else {
      out[k] = v;
    }
  }
  return out;
}
