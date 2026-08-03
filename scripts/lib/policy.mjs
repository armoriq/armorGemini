// ArmorGemini policy engine.
// Applies natural-language rules against Gemini tool calls.
// Local-only: rules live in $ARMORGEMINI_DATA_DIR/policy.json.

import { readJsonFile, writeJsonFile, resolveDataDir } from "./fs-store.mjs";

const POLICY_FILE = "policy.json";

const DEFAULT_POLICY = {
  version: 1,
  rules: [
    { id: "seed-1", verb: "allow", target: "read_file", note: "seed: read is safe" },
    { id: "seed-2", verb: "allow", target: "list_directory", note: "seed: list is safe" },
    { id: "seed-3", verb: "hold", target: "run_shell_command", note: "seed: shell requires approval" },
    { id: "seed-4", verb: "hold", target: "write_file", note: "seed: writes require approval" },
    { id: "seed-5", verb: "hold", target: "replace", note: "seed: replace requires approval" }
  ]
};

export async function loadPolicy() {
  const p = await readJsonFile(POLICY_FILE);
  if (!p) {
    await writeJsonFile(POLICY_FILE, DEFAULT_POLICY);
    return DEFAULT_POLICY;
  }
  return p;
}

export async function savePolicy(policy) {
  await writeJsonFile(POLICY_FILE, policy);
}

// Evaluate a tool call against the policy.
// Returns:
//   { verdict: "allow", rule?: <matched rule> }
//   { verdict: "deny",  rule: <matched rule>, reason }
//   { verdict: "hold",  rule: <matched rule>, reason }
export async function evaluate({ toolName, toolInput }) {
  const policy = await loadPolicy();
  const match = (policy.rules || []).find((r) => matches(r, toolName, toolInput));

  if (!match) {
    return { verdict: "allow" }; // default-allow when no rule matches (spike behavior; production would be default-deny)
  }

  switch (match.verb) {
    case "allow":
      return { verdict: "allow", rule: match };
    case "deny":
      return { verdict: "deny", rule: match, reason: match.note || `Policy denies ${toolName}` };
    case "hold":
      return { verdict: "hold", rule: match, reason: match.note || `Policy holds ${toolName} for approval` };
    default:
      return { verdict: "allow", rule: match };
  }
}

function matches(rule, toolName, _toolInput) {
  if (!rule || !rule.target) return false;
  // Exact tool name match. Later: regex, tool-parameter matching, data-class match.
  return rule.target === toolName || rule.target === "*";
}

export function policyRoot() {
  return resolveDataDir();
}
