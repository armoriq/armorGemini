// Local active policy for ArmorGemini.
//
// Design: /armor:yes writes the confirmed policy to $dataDir/policy.json.
// BeforeTool reads it and evaluates the tool call against the statements
// before calling the backend. If local denies, the tool is blocked without
// a network hop. If local allows or has no matching statement, the backend
// still gets consulted for org-wide policy.
//
// This mirrors ArmorClaude, where local is authoritative for enforcement
// and the backend is audit + fleet propagation. It's the only way to get
// "/armor:yes is the only confirmation" today, because the backend's
// activation endpoint (/policies/profiles/confirm) is JWT-only.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

// Same Gemini->backend tool name mapping the client uses when staging a
// policy. Duplicated here (not imported) so this module stays free of the
// backend client and can be loaded by BeforeTool with zero cost even when
// no policy file exists.
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

function activePath(dataDir) {
  return path.join(dataDir, "policy.json");
}

/**
 * Write the confirmed active policy. Overwrites the previous active policy
 * atomically-enough for a single-user tool. Called by /armor:yes after the
 * user has previewed the staged proposal and confirmed.
 */
export function saveActivePolicy(dataDir, policy) {
  mkdirSync(dataDir, { recursive: true });
  const record = {
    savedAt: new Date().toISOString(),
    policy
  };
  writeFileSync(activePath(dataDir), JSON.stringify(record, null, 2) + "\n");
  return record;
}

/**
 * Read the currently active local policy. Returns null when no file has
 * been written (BeforeTool then falls through to backend-only enforcement).
 */
export function readActivePolicy(dataDir) {
  const p = activePath(dataDir);
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf-8"));
    return parsed?.policy || null;
  } catch {
    return null;
  }
}

export function hasActivePolicy(dataDir) {
  return existsSync(activePath(dataDir));
}

function normalizeToolName(name) {
  const key = String(name || "").toLowerCase();
  return GEMINI_TO_BACKEND_TOOL[key] || name;
}

/**
 * Evaluate a tool call against the local policy. Returns:
 *   { decision: "allow" | "deny", matched: statement | null, reason: string }
 * `matched` is the statement that produced the decision (null when the
 * default decision was applied).
 *
 * Rules follow the armor.policy.v1 semantics we already emit:
 *   - statements are considered in order
 *   - a statement matches when action.eq matches the incoming tool name
 *     (case-insensitive on the normalized Gemini->backend key) or when
 *     action.eq === "*"
 *   - effect "forbid" wins over "permit" via conflictResolution: deny_overrides
 *   - if no statement matches, defaults.decision applies
 */
export function evaluateLocalPolicy(policy, toolName) {
  if (!policy || typeof policy !== "object") {
    return { decision: "allow", matched: null, reason: "no local policy" };
  }
  const normalized = normalizeToolName(toolName).toLowerCase();
  const statements = Array.isArray(policy.statements) ? policy.statements : [];
  const conflict = policy.defaults?.conflictResolution || "deny_overrides";
  const defaultDecision = policy.defaults?.decision === "deny" ? "deny" : "allow";

  let matchedPermit = null;
  let matchedForbid = null;

  for (const s of statements) {
    const eq = String(s?.action?.eq || "").toLowerCase();
    if (!eq) continue;
    const matches = eq === "*" || eq === normalized;
    if (!matches) continue;
    if (s.effect === "forbid" && !matchedForbid) matchedForbid = s;
    if (s.effect === "permit" && !matchedPermit) matchedPermit = s;
  }

  if (conflict === "deny_overrides") {
    if (matchedForbid) {
      return {
        decision: "deny",
        matched: matchedForbid,
        reason: `Local policy statement ${matchedForbid.id} denies ${toolName}`
      };
    }
    if (matchedPermit) {
      return {
        decision: "allow",
        matched: matchedPermit,
        reason: `Local policy statement ${matchedPermit.id} permits ${toolName}`
      };
    }
  } else {
    if (matchedPermit) {
      return {
        decision: "allow",
        matched: matchedPermit,
        reason: `Local policy statement ${matchedPermit.id} permits ${toolName}`
      };
    }
    if (matchedForbid) {
      return {
        decision: "deny",
        matched: matchedForbid,
        reason: `Local policy statement ${matchedForbid.id} denies ${toolName}`
      };
    }
  }

  return {
    decision: defaultDecision,
    matched: null,
    reason: `Local policy default (${defaultDecision})`
  };
}
