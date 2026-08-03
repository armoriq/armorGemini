import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const TMP = mkdtempSync(path.join(tmpdir(), "armorgemini-engine-"));
process.env.ARMORGEMINI_DATA_DIR = TMP;

const { onBeforeTool, onAfterTool, onSessionStart, onSessionEnd } = await import("../scripts/lib/engine.mjs");

const basePayload = {
  session_id: "test-session",
  cwd: "/tmp/test",
  hook_event_name: "BeforeTool",
  timestamp: new Date().toISOString()
};

test("onBeforeTool allows read_file", async () => {
  const decision = await onBeforeTool({
    ...basePayload,
    tool_name: "read_file",
    tool_input: { path: "README.md" }
  });
  assert.equal(decision.decision, "allow");
});

test("onBeforeTool denies run_shell_command via hold (surfaces user-approval prompt)", async () => {
  const decision = await onBeforeTool({
    ...basePayload,
    tool_name: "run_shell_command",
    tool_input: { command: "ls" }
  });
  assert.equal(decision.decision, "deny");
  assert.match(decision.reason, /Confirm with the user/);
  assert.match(decision.systemMessage, /ArmorGemini/);
});

test("onAfterTool writes an audit line and returns empty decision", async () => {
  const decision = await onAfterTool({
    ...basePayload,
    hook_event_name: "AfterTool",
    tool_name: "list_directory",
    tool_input: { dir_path: "/tmp" },
    tool_response: {
      llmContent: "some listing",
      returnDisplay: { summary: "Found 2 items", files: ["a.txt", "b.txt"] }
    }
  });
  assert.deepEqual(decision, {});

  const auditDir = path.join(TMP, "audit");
  const files = readdirSync(auditDir);
  assert.ok(files.length >= 1, "audit day file should exist");
});

test("onSessionStart / onSessionEnd return empty decisions", async () => {
  assert.deepEqual(await onSessionStart({ ...basePayload, hook_event_name: "SessionStart" }), {});
  assert.deepEqual(await onSessionEnd({ ...basePayload, hook_event_name: "SessionEnd" }), {});
});

process.on("exit", () => rmSync(TMP, { recursive: true, force: true }));
