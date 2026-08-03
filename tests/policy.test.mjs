import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Redirect data dir to a temp folder so tests are hermetic.
const TMP = mkdtempSync(path.join(tmpdir(), "armorgemini-"));
process.env.ARMORGEMINI_DATA_DIR = TMP;

const { evaluate, loadPolicy, savePolicy } = await import("../scripts/lib/policy.mjs");

test("evaluate() allows read_file per seed rule", async () => {
  const r = await evaluate({ toolName: "read_file", toolInput: { path: "README.md" } });
  assert.equal(r.verdict, "allow");
  assert.equal(r.rule?.target, "read_file");
});

test("evaluate() holds run_shell_command per seed rule", async () => {
  const r = await evaluate({ toolName: "run_shell_command", toolInput: { command: "ls" } });
  assert.equal(r.verdict, "hold");
});

test("evaluate() defaults to allow for unmatched tools (spike behavior)", async () => {
  const r = await evaluate({ toolName: "no_such_tool", toolInput: {} });
  assert.equal(r.verdict, "allow");
});

test("evaluate() honors a custom deny rule", async () => {
  const p = await loadPolicy();
  p.rules.push({ id: "test-deny", verb: "deny", target: "web_fetch", note: "Block outbound" });
  await savePolicy(p);
  const r = await evaluate({ toolName: "web_fetch", toolInput: { url: "https://example.com" } });
  assert.equal(r.verdict, "deny");
  assert.match(r.reason, /Block outbound/);
});

process.on("exit", () => rmSync(TMP, { recursive: true, force: true }));
