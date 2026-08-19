import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  saveActivePolicy,
  readActivePolicy,
  hasActivePolicy,
  evaluateLocalPolicy
} from "../scripts/lib/local-policy.mjs";
import { buildPolicyForRule } from "../scripts/lib/backend-client.mjs";

function scratch() {
  return mkdtempSync(path.join(tmpdir(), "armorgemini-local-policy-"));
}

test("saveActivePolicy + readActivePolicy round-trip", () => {
  const dir = scratch();
  try {
    const policy = buildPolicyForRule({ verb: "deny", target: "run_shell_command" });
    saveActivePolicy(dir, policy);
    assert.equal(hasActivePolicy(dir), true);
    const read = readActivePolicy(dir);
    assert.equal(read.statements[0].action.eq, "Bash");
    assert.equal(read.statements[0].effect, "forbid");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("evaluateLocalPolicy denies a Gemini-name tool call that matches a Claude-name forbid statement", () => {
  const policy = buildPolicyForRule({ verb: "deny", target: "web_fetch" });
  const v = evaluateLocalPolicy(policy, "web_fetch");
  assert.equal(v.decision, "deny");
  assert.equal(v.matched.action.eq, "WebFetch");
});

test("evaluateLocalPolicy allows a tool with no matching statement (default allow)", () => {
  const policy = buildPolicyForRule({ verb: "deny", target: "web_fetch" });
  const v = evaluateLocalPolicy(policy, "read_file");
  assert.equal(v.decision, "allow");
  assert.equal(v.matched, null);
});

test("evaluateLocalPolicy: wildcard statement denies every tool when default is deny_overrides", () => {
  const policy = {
    schemaVersion: "armor.policy.v1",
    kind: "PolicyProfile",
    metadata: { name: "lockdown-test", description: "" },
    defaults: { decision: "deny", conflictResolution: "deny_overrides" },
    statements: [
      {
        id: "lockdown-all",
        effect: "forbid",
        principal: { type: "agent", id: "gemini-cli" },
        action: { type: "tool", eq: "*" },
        resource: { type: "workspace", scope: "current" },
        conditions: []
      }
    ]
  };
  for (const tool of ["read_file", "write_file", "run_shell_command", "google_web_search"]) {
    assert.equal(evaluateLocalPolicy(policy, tool).decision, "deny", `should deny ${tool}`);
  }
});

test("evaluateLocalPolicy: no local policy at all is treated as allow", () => {
  const v = evaluateLocalPolicy(null, "read_file");
  assert.equal(v.decision, "allow");
});

test("evaluateLocalPolicy: permit + forbid on same tool → deny wins (deny_overrides)", () => {
  const policy = {
    schemaVersion: "armor.policy.v1",
    kind: "PolicyProfile",
    metadata: { name: "conflict", description: "" },
    defaults: { decision: "allow", conflictResolution: "deny_overrides" },
    statements: [
      {
        id: "allow-fetch",
        effect: "permit",
        principal: { type: "agent", id: "gemini-cli" },
        action: { type: "tool", eq: "WebFetch" },
        resource: { type: "workspace", scope: "current" },
        conditions: []
      },
      {
        id: "deny-fetch",
        effect: "forbid",
        principal: { type: "agent", id: "gemini-cli" },
        action: { type: "tool", eq: "WebFetch" },
        resource: { type: "workspace", scope: "current" },
        conditions: []
      }
    ]
  };
  const v = evaluateLocalPolicy(policy, "web_fetch");
  assert.equal(v.decision, "deny");
  assert.equal(v.matched.id, "deny-fetch");
});
