// ArmorGemini engine.
//
// v0.3 flow (matches ArmorClaude's enforcement model, ported to Gemini's
// hook set):
//
//   SessionStart        show ENFORCING banner
//   BeforeAgent         inject a directive telling the model to call
//                       register_intent_plan (our MCP tool) BEFORE any
//                       other tool. drops the session_id inline so the
//                       model can pass it back.
//   BeforeToolSelection whitelist the model's tool surface to exactly
//                       what the plan says it can use, if a plan is
//                       registered. structural enforcement — the model
//                       cannot even ATTEMPT a tool that is off-plan.
//   BeforeTool          two-layer check:
//                         1. intent drift: tool must be in the plan
//                         2. policy: backend /iap/enforce verdict
//                       either failing → deny.
//   AfterTool           best-effort audit to /iap/audit
//   SessionEnd          clear the session's plan file so we don't leak
//
// If the plugin is not configured (missing API key), hooks fail closed.
// If ARMORGEMINI_INTENT_REQUIRED=false, the drift check is skipped and
// enforcement falls back to policy-only (v0.2 behavior) for operators
// mid-migration.

import { loadConfig } from "./config.mjs";
import { verifyStep, sendAudit } from "./backend-client.mjs";
import { writeLog } from "./hook-io.mjs";
import { INTENT_PLAN_FORMAT, planContainsTool, planToolNames } from "./intent-schema.mjs";
import { loadPlan, hasPlan, clearPlan, planAgeSeconds } from "./planner.mjs";

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

// ---------------------------------------------------------------------------
// SessionStart
// ---------------------------------------------------------------------------

export async function onSessionStart(payload) {
  const config = loadConfig();
  writeLog(
    `SessionStart session=${payload?.session_id || "?"} cwd=${payload?.cwd || "?"} configured=${config.isConfigured} intentRequired=${config.intentRequired}`
  );
  if (!config.isConfigured) {
    return {
      systemMessage:
        "🛡️ ArmorGemini not connected. Run `armoriq login --product armorgemini` to enable enforcement."
    };
  }
  const mode = config.intentRequired ? "ENFORCING · intent required" : "ENFORCING · policy only";
  return {
    systemMessage:
      `🛡️ ArmorGemini active (${mode}). Every tool call is checked against your ArmorIQ policy and your registered intent plan.`
  };
}

// ---------------------------------------------------------------------------
// SessionEnd
// ---------------------------------------------------------------------------

export async function onSessionEnd(payload) {
  const config = loadConfig();
  const sessionId = payload?.session_id || "";
  if (config.isConfigured && sessionId) {
    clearPlan(config.dataDir, sessionId);
  }
  writeLog(`SessionEnd session=${sessionId}`);
  return {};
}

// ---------------------------------------------------------------------------
// BeforeAgent — inject the "declare your plan first" directive.
// This is the Gemini-CLI equivalent of Claude Code's UserPromptSubmit hook:
// it fires per user turn, and its additionalContext output is appended to
// the model's prompt for that turn only.
// ---------------------------------------------------------------------------

export async function onBeforeAgent(payload) {
  const config = loadConfig();
  if (!config.isConfigured) {
    // We can't sensibly enforce anything without an API key, but blocking
    // the turn here would prevent the user from ever getting to the
    // "please configure" message. Let the turn through; BeforeTool will
    // still deny actual tool use with the not-configured reason.
    return {};
  }
  if (!config.intentRequired) {
    // Operator opted into policy-only mode. No directive to inject.
    return {};
  }

  const sessionId = payload?.session_id || "";
  const directive =
    `[ArmorGemini enforcement is active for this session, id: ${sessionId}]\n` +
    `Before you call ANY tool this turn, you MUST first call the tool ` +
    `\`register_intent_plan\` (provided by the armorgemini-policy MCP server) ` +
    `with the plan you are about to execute. Pass the session_id above verbatim.\n\n` +
    `Plan shape (JSON):\n${INTENT_PLAN_FORMAT}\n\n` +
    `Every subsequent tool call is checked against this plan; a tool not in ` +
    `\`steps[].action\` will be denied. If your plan needs to change mid-turn, ` +
    `call \`register_intent_plan\` again with the updated plan before continuing. ` +
    `Use \`reset_intent_plan\` to discard the current plan explicitly.`;

  writeLog(`BeforeAgent session=${sessionId} injected directive`);
  return {
    hookSpecificOutput: {
      hookEventName: "BeforeAgent",
      additionalContext: directive
    }
  };
}

// ---------------------------------------------------------------------------
// BeforeToolSelection — no-op for now.
//
// The design goal was to hand Gemini an `allowedFunctionNames` whitelist so
// the model literally cannot see off-plan tools when it picks. Google's
// Gemini API rejects that combination with:
//
//   Please set allowed_function_names only when function calling mode is ANY.
//
// mode: "ANY" would work with the whitelist but it forces the model to call
// a tool on every turn, which breaks plain text turns (greetings, follow-up
// questions, "thanks that helps"). Until we have a reliable per-turn signal
// for "the model actually needs a tool this turn" we cannot use mode: ANY
// safely, and mode: AUTO forbids the whitelist.
//
// Returning {} here disables the structural pre-filter and leaves
// enforcement to the BeforeTool hook, which already denies off-plan tools
// and off-plan tool inputs. Behavior is identical from a security posture
// standpoint; we just lose the "the model never even sees the tool" bonus.
// ---------------------------------------------------------------------------

const ALWAYS_ALLOWED_TOOLS = [
  "register_intent_plan",
  "reset_intent_plan",
  "get_intent_plan"
];

export async function onBeforeToolSelection(_payload) {
  return {};
}

// ---------------------------------------------------------------------------
// BeforeTool — two-layer enforcement: plan drift, then backend policy.
// ---------------------------------------------------------------------------

function isMcpArmorTool(toolName) {
  const t = String(toolName || "").toLowerCase();
  return ALWAYS_ALLOWED_TOOLS.some((n) => t === n || t.endsWith(`__${n}`));
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

  // Our own MCP tools always allowed; otherwise the plan registration
  // would itself require a plan and nothing would ever run.
  if (isMcpArmorTool(toolName)) {
    writeLog(`ALLOW ${toolName} - armorgemini-policy MCP tool`);
    return {
      decision: "allow",
      systemMessage: `🛡️ ArmorGemini: ${toolName} (plan management, always allowed)`
    };
  }

  // --- Layer 1: intent-plan drift check (skipped in policy-only mode) ---
  if (config.intentRequired) {
    if (!hasPlan(config.dataDir, sessionId)) {
      writeLog(`DENY ${toolName} - no intent plan registered`);
      return {
        decision: "deny",
        reason:
          `ArmorGemini denies ${toolName}: no intent plan registered for this session. ` +
          `Call register_intent_plan (armorgemini-policy MCP) with your plan first, ` +
          `then retry. Set ARMORGEMINI_INTENT_REQUIRED=false to disable this check.`,
        systemMessage: `🛡️ ArmorGemini blocked ${toolName} — no plan registered`
      };
    }
    const age = planAgeSeconds(config.dataDir, sessionId);
    if (age > config.planTtlSeconds) {
      writeLog(`DENY ${toolName} - plan expired (age=${age}s ttl=${config.planTtlSeconds}s)`);
      return {
        decision: "deny",
        reason:
          `ArmorGemini denies ${toolName}: the current intent plan is ${Math.round(age)}s old ` +
          `(TTL is ${config.planTtlSeconds}s). Call register_intent_plan with a fresh plan and retry.`,
        systemMessage: `🛡️ ArmorGemini blocked ${toolName} — plan expired, re-plan required`
      };
    }
    const plan = loadPlan(config.dataDir, sessionId);
    if (!planContainsTool(plan, toolName)) {
      writeLog(`DENY ${toolName} - intent drift (not in plan steps)`);
      return {
        decision: "deny",
        reason:
          `ArmorGemini intent drift: ${toolName} is not in the registered plan for this session. ` +
          `Plan allowed: ${planToolNames(plan).join(", ")}. ` +
          `Re-plan via register_intent_plan if you genuinely need this tool.`,
        systemMessage: `🛡️ ArmorGemini blocked ${toolName} — intent drift`
      };
    }
  }

  // --- Layer 2: backend policy check ---
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
      : `🛡️ ArmorGemini: ${toolName} allowed (${config.intentRequired ? "in plan, " : ""}no matching deny policy)`
  };
}

// ---------------------------------------------------------------------------
// AfterTool
// ---------------------------------------------------------------------------

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
