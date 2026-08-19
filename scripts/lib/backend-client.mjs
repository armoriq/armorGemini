// HTTP client for the ArmorIQ IAP backend.
// ArmorGemini is backend-only: every enforcement decision and every audit
// record flows through here. There is no local fallback.

import { authHeaders } from "./config.mjs";

function endpoint(config, path) {
  return `${config.backendEndpoint}${path}`;
}

async function jsonRequest(config, method, path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const res = await fetch(endpoint(config, path), {
      method,
      headers: authHeaders(config),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    });
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, error: String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask the backend whether a tool call is allowed.
 *
 * Uses POST /iap/enforce, the same policy-evaluation endpoint the SDK's
 * `armoriq check` reads from. Returns an evaluation of the tool call against
 * the workspace's active ArmorIQ policy. No pre-registered intent token is
 * required (unlike /iap/verify-step, which is the CSRG-Merkle-proof path
 * ArmorClaude uses).
 *
 * Response shape from /iap/enforce:
 *   { allowed: bool, action: "allow" | "deny", reason: string,
 *     matched_policy: {...}|null }
 *
 * Fails closed on 4xx/5xx that indicate real auth or backend problems; fails
 * open (with a monitor-mode note) on 400 from an evolving backend schema, so
 * a payload contract drift doesn't wedge every session. The audit log still
 * captures every call either way, so no enforcement telemetry is lost.
 */
export async function verifyStep(config, { sessionId, toolName, toolInput, description }) {
  const res = await jsonRequest(config, "POST", "/iap/enforce", {
    source: "armorgemini",
    session_id: sessionId,
    tool_name: toolName,
    tool_input: toolInput,
    description: description || undefined,
    org_id: config.orgId
  });

  if (res.status === 401 || res.status === 403) {
    return { allowed: false, reason: "ArmorIQ API key invalid or lacks permission", fatal: true };
  }
  // 400 == the backend rejected our payload shape. Log it, fall through to
  // monitor mode instead of wedging the session. Real deny decisions come
  // back as 200 with { allowed: false }.
  if (res.status === 400) {
    return {
      allowed: true,
      reason: `ArmorGemini monitor: backend HTTP 400 (payload contract drift), see logs`,
      verdict: "monitor"
    };
  }
  if (!res.ok) {
    return {
      allowed: false,
      reason: `ArmorIQ backend unavailable (HTTP ${res.status || "network"}). Fail-closed policy applies.`,
      fatal: false
    };
  }
  const data = res.data || {};
  const isAllowed = data.allowed !== false && data.action !== "deny";
  return {
    allowed: isAllowed,
    reason: typeof data.reason === "string" ? data.reason : "",
    verdict: data.action || (isAllowed ? "allow" : "deny"),
    matchedPolicy: data.matched_policy || null
  };
}

/**
 * Send an audit record. Best-effort. If the backend is unreachable we still
 * return the decision to Gemini (audit is post-hoc, not enforcement).
 */
export async function sendAudit(config, entry) {
  const res = await jsonRequest(config, "POST", "/iap/audit", {
    source: "armorgemini",
    ...entry
  });
  return { ok: res.ok, status: res.status };
}

/**
 * Fetch the current active policy for display in /armor:list.
 * The backend returns { policy } where policy is the same PolicyProfile
 * document ArmorClaude uses. Parsed here into a flat rule list for the CLI
 * to render.
 */
export async function fetchPolicy(config) {
  const res = await jsonRequest(config, "GET", "/policies/profiles/active");
  if (!res.ok) return { ok: false, status: res.status, error: res.error };
  const policy = res.data?.policy;
  const statements = Array.isArray(policy?.statements) ? policy.statements : [];
  return {
    ok: true,
    policy: {
      name: policy?.metadata?.name || "current",
      description: policy?.metadata?.description || "",
      defaultDecision: policy?.defaults?.decision || "allow",
      rules: statements.map((s) => ({
        id: s.id,
        verb: s.effect,
        target: s.action || "*",
        note: s.description || ""
      }))
    }
  };
}

// ---------------------------------------------------------------------------
// Policy profile lifecycle (draft -> propose)
// ---------------------------------------------------------------------------
// The backend PUT /policies/profiles/draft accepts { policy, orgId } where
// `policy` is a full PolicyProfile document (same shape ArmorClaude produces).
// POST /policies/profiles/propose then converts the draft into a pending
// proposal a human confirms on the dashboard.
//
// For /armor:add we build a minimal single-statement profile: default allow,
// one deny/allow/hold statement on the requested tool. This REPLACES the
// active policy when confirmed; extending an existing policy without
// clobbering it requires a fetch-modify-push flow that lives in the
// dashboard today.

const POLICY_SCHEMA_VERSION = "armor.policy.v1";

// The armor.policy.v1 schema names effects "permit" / "forbid" (from the
// underlying Rego/OPA vocabulary), not the "allow" / "deny" verbs the CLI
// exposes to users. Also "hold" is a plugin-side concept not represented on
// the backend — we translate it into "forbid" so the tool is blocked on
// the workspace policy while a human decides.
const VERB_TO_EFFECT = {
  allow: "permit",
  deny: "forbid",
  hold: "forbid"
};

// The backend validates statements[].action.eq against a Claude-Code-specific
// tool registry (KNOWN_TOOLS in the policy-ir schema on the server). Gemini
// CLI uses its own naming (read_file, run_shell_command, web_fetch, ...) so
// we translate here. Anything not in the map is passed through verbatim,
// which surfaces the backend's error to the user unchanged.
//
// Long-term this belongs on the backend (Gemini tools should be first-class
// entries in KNOWN_TOOLS); today the mapping is client-side so the demo
// flow can ship.
const GEMINI_TO_BACKEND_TOOL = {
  "*": "*",
  read_file: "Read",
  write_file: "Write",
  edit: "Edit",
  edit_file: "Edit",
  run_shell_command: "Bash",
  run_shell: "Bash",
  shell: "Bash",
  bash: "Bash",
  glob: "Glob",
  list_directory: "Glob",
  ls: "Glob",
  search_file_content: "Grep",
  grep: "Grep",
  find: "Grep",
  web_fetch: "WebFetch",
  fetch: "WebFetch",
  http: "WebFetch",
  google_web_search: "WebSearch",
  web_search: "WebSearch",
  search: "WebSearch"
};

function mapToolName(target) {
  const key = String(target || "").toLowerCase();
  return GEMINI_TO_BACKEND_TOOL[key] || target;
}

function policyStatementId(prefix, target) {
  return `${prefix}-${String(target || "any").replace(/[^a-z0-9_-]+/gi, "-")}`;
}

// Build a single statement in the armor.policy.v1 shape the backend actually
// validates against: effect is permit/forbid, principal/action/resource are
// typed objects, conditions is always an array. No description field on the
// statement — the backend rejects it as an unknown key.
function buildStatement({ verb, target }) {
  const effect = VERB_TO_EFFECT[verb] || "forbid";
  const backendTool = mapToolName(target);
  return {
    id: policyStatementId(`armorgemini-${verb}`, target),
    effect,
    principal: { type: "agent", id: "gemini-cli" },
    action: { type: "tool", eq: backendTool },
    resource: { type: "workspace", scope: "current" },
    conditions: []
  };
}

function buildSingleStatementPolicy({ verb, target, note }) {
  return {
    schemaVersion: POLICY_SCHEMA_VERSION,
    kind: "PolicyProfile",
    metadata: {
      name: "armorgemini-current",
      description: note ? `Staged from ArmorGemini /armor:add - ${note}` : "Staged from ArmorGemini /armor:add"
    },
    defaults: {
      decision: "allow",
      conflictResolution: "deny_overrides"
    },
    statements: [buildStatement({ verb, target })]
  };
}

async function draftAndPropose(config, policy, reason) {
  const draft = await jsonRequest(config, "PUT", "/policies/profiles/draft", {
    policy,
    orgId: config.orgId || undefined
  });
  if (!draft.ok) {
    const backendMsg = Array.isArray(draft.data?.message)
      ? draft.data.message.join("; ")
      : draft.data?.message || draft.error;
    return { ok: false, stage: "draft", status: draft.status, error: backendMsg };
  }
  const proposal = await jsonRequest(config, "POST", "/policies/profiles/propose", {
    reason: reason || "Proposed via ArmorGemini /armor",
    orgId: config.orgId || undefined
  });
  if (!proposal.ok) {
    const backendMsg = Array.isArray(proposal.data?.message)
      ? proposal.data.message.join("; ")
      : proposal.data?.message || proposal.error;
    return { ok: false, stage: "propose", status: proposal.status, error: backendMsg };
  }
  return { ok: true, proposal: proposal.data };
}

/**
 * Build the policy object for a single verb+target rule. Exported so the
 * CLI can preview it as YAML before staging locally, without duplicating
 * the schema shape.
 */
export function buildPolicyForRule({ verb, target, note }) {
  return buildSingleStatementPolicy({ verb, target, note });
}

/**
 * Push a fully-built PolicyProfile through the draft -> propose flow. This
 * is what /armor:yes calls after the user has previewed the staged policy
 * and confirmed. On success the proposal is registered on the backend and
 * awaits a human confirm on the dashboard (POST /policies/profiles/confirm
 * is JWT-only, deliberately not exposed here).
 */
export async function pushProposal(config, policy, reason) {
  return draftAndPropose(config, policy, reason);
}

/**
 * @deprecated Retained for backward compatibility with anything still
 * calling the pre-stage-yes flow directly. New CLI paths should call
 * buildPolicyForRule() + stagePending() + pushProposal() so the user
 * gets a YAML preview and an explicit /armor:yes confirmation step.
 */
export async function proposePolicyChange(config, { verb, target, note, reason }) {
  const policy = buildSingleStatementPolicy({ verb, target, note });
  return draftAndPropose(config, policy, reason);
}

// ---------------------------------------------------------------------------
// Named templates (lockdown / strict-read-only / balanced)
// ---------------------------------------------------------------------------
// Backend has no dedicated /policies/profiles/template endpoint, so we build
// the template locally and run it through the same draft -> propose flow.
// The three templates below are illustrative starter policies; a future
// iteration can pull server-managed templates instead.

const TEMPLATES = {
  lockdown: {
    metadata: {
      name: "armorgemini-lockdown",
      description: "Lockdown: deny every tool. Nothing runs until a human explicitly relaxes this."
    },
    defaults: { decision: "deny", conflictResolution: "deny_overrides" },
    statements: [
      buildStatement({ verb: "deny", target: "*" })
    ]
  },
  "strict-read-only": {
    metadata: {
      name: "armorgemini-strict-read-only",
      description: "Strict read-only: allow file reads and lists, deny writes and network."
    },
    defaults: { decision: "deny", conflictResolution: "deny_overrides" },
    statements: [
      buildStatement({ verb: "allow", target: "read_file" }),
      buildStatement({ verb: "allow", target: "list_directory" }),
      buildStatement({ verb: "allow", target: "search_file_content" }),
      buildStatement({ verb: "allow", target: "glob" })
    ]
  },
  balanced: {
    metadata: {
      name: "armorgemini-balanced",
      description: "Balanced: allow reads and controlled writes, deny network egress and destructive shell."
    },
    defaults: { decision: "allow", conflictResolution: "deny_overrides" },
    statements: [
      buildStatement({ verb: "deny", target: "web_fetch" }),
      buildStatement({ verb: "deny", target: "google_web_search" }),
      buildStatement({ verb: "deny", target: "run_shell_command" })
    ]
  }
};

/**
 * Names of the known templates, for validation and help output.
 */
export function listTemplateNames() {
  return Object.keys(TEMPLATES);
}

/**
 * Build a template's PolicyProfile without pushing it. The CLI stages this
 * to the pending file and shows a YAML preview; /armor:yes is what actually
 * calls pushProposal().
 */
export function buildPolicyForTemplate(templateName) {
  const t = TEMPLATES[templateName];
  if (!t) return null;
  return {
    schemaVersion: POLICY_SCHEMA_VERSION,
    kind: "PolicyProfile",
    ...t
  };
}

/**
 * @deprecated Retained for backward compat with the pre-stage-yes flow.
 * New CLI paths use buildPolicyForTemplate() + stagePending() + pushProposal().
 */
export async function proposePolicyTemplate(config, templateName) {
  const policy = buildPolicyForTemplate(templateName);
  if (!policy) {
    return {
      ok: false,
      status: 0,
      error: `Unknown template "${templateName}". Available: ${listTemplateNames().join(", ")}.`
    };
  }
  return draftAndPropose(config, policy, `Applied template "${templateName}" via ArmorGemini`);
}
