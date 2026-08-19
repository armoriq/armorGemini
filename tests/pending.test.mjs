import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { stagePending, readPending, clearPending, hasPending } from "../scripts/lib/pending.mjs";
import { policyToYaml } from "../scripts/lib/policy-yaml.mjs";
import { buildPolicyForRule, buildPolicyForTemplate, listTemplateNames } from "../scripts/lib/backend-client.mjs";

function scratch() {
  return mkdtempSync(path.join(tmpdir(), "armorgemini-pending-"));
}

test("stagePending writes a proposal with id + expiresAt; readPending returns it", () => {
  const dir = scratch();
  try {
    const policy = buildPolicyForRule({ verb: "deny", target: "web_fetch", note: "no exfil" });
    const record = stagePending(dir, { policy, reason: "test", source: "unit" });
    assert.ok(record.proposalId.startsWith("prop_"));
    assert.ok(Date.parse(record.expiresAt) > Date.now());
    assert.equal(hasPending(dir), true);
    const { record: read, expired } = readPending(dir);
    assert.equal(expired, false);
    assert.equal(read.proposalId, record.proposalId);
    assert.equal(read.policy.statements[0].action.eq, "WebFetch");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clearPending removes the proposal file", () => {
  const dir = scratch();
  try {
    stagePending(dir, {
      policy: buildPolicyForRule({ verb: "allow", target: "read_file" }),
      reason: "test",
      source: "unit"
    });
    assert.equal(hasPending(dir), true);
    clearPending(dir);
    assert.equal(hasPending(dir), false);
    assert.equal(readPending(dir).record, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stagePending overwrites a prior proposal (only one pending at a time)", () => {
  const dir = scratch();
  try {
    const a = stagePending(dir, {
      policy: buildPolicyForRule({ verb: "deny", target: "web_fetch" }),
      reason: "first",
      source: "unit"
    });
    const b = stagePending(dir, {
      policy: buildPolicyForRule({ verb: "deny", target: "run_shell_command" }),
      reason: "second",
      source: "unit"
    });
    assert.notEqual(a.proposalId, b.proposalId);
    const { record } = readPending(dir);
    assert.equal(record.proposalId, b.proposalId);
    assert.equal(record.policy.statements[0].action.eq, "Bash");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("policyToYaml renders each field of an armor.policy.v1 profile in a readable shape", () => {
  const policy = buildPolicyForRule({ verb: "deny", target: "web_fetch", note: "no exfil" });
  const yaml = policyToYaml(policy);
  assert.match(yaml, /schemaVersion: armor\.policy\.v1/);
  assert.match(yaml, /kind: PolicyProfile/);
  assert.match(yaml, /effect: forbid/);
  assert.match(yaml, /action:\s+type: tool\s+eq: WebFetch/);
  assert.match(yaml, /conditions: \[\]/);
});

test("buildPolicyForTemplate returns the balanced template with three deny statements", () => {
  const policy = buildPolicyForTemplate("balanced");
  assert.equal(policy.metadata.name, "armorgemini-balanced");
  assert.equal(policy.statements.length, 3);
  const targets = policy.statements.map((s) => s.action.eq).sort();
  assert.deepEqual(targets, ["Bash", "WebFetch", "WebSearch"]);
});

test("listTemplateNames returns exactly the shipped templates", () => {
  const names = listTemplateNames().sort();
  assert.deepEqual(names, ["balanced", "lockdown", "strict-read-only"]);
});
