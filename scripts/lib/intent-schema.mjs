// ArmorGemini intent-plan schema.
//
// A "plan" is the declaration the model makes at the start of a turn about
// which tools it is about to call and why. ArmorGemini enforces that every
// tool call at BeforeTool time is present in the plan; drift is denied.
//
// Shape kept small on purpose. The model produces this via the directive
// injected by onBeforeAgent, either by calling the register_intent_plan
// MCP tool the plugin bundles, or as a fenced ```json block in a plan
// artifact. We validate both.
//
// This file is stdlib-only so it can be imported by scripts/policy-mcp.mjs
// (an MCP server child process) without paying the cost of pulling in the
// full engine.

/**
 * Human-readable schema string injected into the model's context. Uses
 * concrete Gemini CLI tool names so the model doesn't have to guess.
 */
export const INTENT_PLAN_FORMAT = `{
  "goal": "<one-line summary of the task>",
  "steps": [
    {
      "action": "<Gemini CLI tool name, e.g. read_file, write_file, run_shell_command, google_web_search, web_fetch, glob, list_directory, search_file_content, edit>",
      "description": "<why this step is needed>",
      "metadata": { "inputs": { "/* expected tool parameters, optional */": "" } }
    }
  ]
}`;

/**
 * Validate a raw parsed object against the intent-plan shape. Returns
 * { ok: true, plan } on success or { ok: false, error } on failure with a
 * human-readable reason.
 *
 * Deliberately hand-rolled: keeps this module dependency-free so the MCP
 * server can import it without dragging the engine or the backend client.
 */
export function validateIntentPlan(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "plan must be a JSON object" };
  }
  if (typeof raw.goal !== "string" || raw.goal.trim().length === 0) {
    return { ok: false, error: "plan.goal must be a non-empty string" };
  }
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
    return { ok: false, error: "plan.steps must be a non-empty array" };
  }
  const steps = [];
  for (let i = 0; i < raw.steps.length; i += 1) {
    const s = raw.steps[i];
    if (s === null || typeof s !== "object" || Array.isArray(s)) {
      return { ok: false, error: `plan.steps[${i}] must be an object` };
    }
    if (typeof s.action !== "string" || s.action.trim().length === 0) {
      return { ok: false, error: `plan.steps[${i}].action must be a non-empty string` };
    }
    if (s.description !== undefined && typeof s.description !== "string") {
      return { ok: false, error: `plan.steps[${i}].description must be a string when set` };
    }
    if (s.metadata !== undefined && (s.metadata === null || typeof s.metadata !== "object" || Array.isArray(s.metadata))) {
      return { ok: false, error: `plan.steps[${i}].metadata must be an object when set` };
    }
    steps.push({
      action: s.action.trim(),
      description: typeof s.description === "string" ? s.description : "",
      metadata: (s.metadata && typeof s.metadata === "object") ? s.metadata : {}
    });
  }
  return {
    ok: true,
    plan: {
      goal: raw.goal.trim(),
      steps
    }
  };
}

/**
 * Return the set of tool names declared in the plan (case-insensitive,
 * trimmed). Used by BeforeToolSelection to build a Gemini-side whitelist
 * and by BeforeTool to check drift.
 */
export function planToolNames(plan) {
  if (!plan || !Array.isArray(plan.steps)) return [];
  const seen = new Set();
  for (const s of plan.steps) {
    if (typeof s?.action === "string") {
      seen.add(s.action.trim().toLowerCase());
    }
  }
  return Array.from(seen);
}

/**
 * True iff `toolName` is present in the plan. Case-insensitive to survive
 * Gemini emitting different casing (e.g. "read_file" vs "ReadFile"). Names
 * in the plan are already normalized by planToolNames.
 */
export function planContainsTool(plan, toolName) {
  if (!plan || typeof toolName !== "string") return false;
  const needle = toolName.trim().toLowerCase();
  return planToolNames(plan).includes(needle);
}
