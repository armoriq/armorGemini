import { test, mock } from "node:test";
import assert from "node:assert/strict";

// ArmorGemini is backend-only: engine tests set / clear env for API key and
// stub global fetch to simulate backend responses.

const basePayload = {
  session_id: "test-session",
  cwd: "/tmp/test",
  hook_event_name: "BeforeTool",
  timestamp: new Date().toISOString()
};

function withEnv(patch, fn) {
  const original = {};
  for (const key of Object.keys(patch)) {
    original[key] = process.env[key];
    if (patch[key] === undefined) delete process.env[key];
    else process.env[key] = patch[key];
  }
  return Promise.resolve(fn()).finally(() => {
    for (const [key, val] of Object.entries(original)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });
}

async function loadEngineFresh() {
  const url = new URL("../scripts/lib/engine.mjs", import.meta.url).href + `?t=${Date.now()}${Math.random()}`;
  return import(url);
}

test("onBeforeTool DENIES every tool when ARMORIQ_API_KEY is missing (fail-closed)", async () => {
  await withEnv({ ARMORIQ_API_KEY: undefined, ARMORGEMINI_API_KEY: undefined }, async () => {
    const { onBeforeTool } = await loadEngineFresh();
    const decision = await onBeforeTool({
      ...basePayload,
      tool_name: "read_file",
      tool_input: { path: "README.md" }
    });
    assert.equal(decision.decision, "deny");
    assert.match(decision.reason, /API key/);
    assert.match(decision.systemMessage, /not configured/);
  });
});

test("onBeforeTool ALLOWS when backend returns allowed=true", async () => {
  await withEnv({ ARMORIQ_API_KEY: "test-key" }, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ allowed: true, verdict: "allow" })
    }));
    try {
      const { onBeforeTool } = await loadEngineFresh();
      const decision = await onBeforeTool({
        ...basePayload,
        tool_name: "read_file",
        tool_input: { path: "README.md" }
      });
      assert.equal(decision.decision, "allow");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("onBeforeTool DENIES when backend returns allowed=false", async () => {
  await withEnv({ ARMORIQ_API_KEY: "test-key" }, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        allowed: false,
        reason: "run_shell_command denied by workspace policy",
        verdict: "deny"
      })
    }));
    try {
      const { onBeforeTool } = await loadEngineFresh();
      const decision = await onBeforeTool({
        ...basePayload,
        tool_name: "run_shell_command",
        tool_input: { command: "ls" }
      });
      assert.equal(decision.decision, "deny");
      assert.match(decision.reason, /workspace policy/);
      assert.match(decision.systemMessage, /ArmorGemini blocked/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("onBeforeTool FATAL deny on 401 auth error", async () => {
  await withEnv({ ARMORIQ_API_KEY: "wrong-key" }, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => null
    }));
    try {
      const { onBeforeTool } = await loadEngineFresh();
      const decision = await onBeforeTool({
        ...basePayload,
        tool_name: "read_file",
        tool_input: { path: "README.md" }
      });
      assert.equal(decision.decision, "deny");
      assert.match(decision.reason, /API key invalid/);
      assert.match(decision.systemMessage, /fatal auth error/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("onBeforeTool DENIES fail-closed on backend network error", async () => {
  await withEnv({ ARMORIQ_API_KEY: "test-key" }, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async () => {
      throw new Error("network unreachable");
    });
    try {
      const { onBeforeTool } = await loadEngineFresh();
      const decision = await onBeforeTool({
        ...basePayload,
        tool_name: "read_file",
        tool_input: { path: "README.md" }
      });
      assert.equal(decision.decision, "deny");
      assert.match(decision.reason, /Fail-closed/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("onAfterTool sends audit best-effort and returns empty decision", async () => {
  await withEnv({ ARMORIQ_API_KEY: "test-key" }, async () => {
    let called = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async () => {
      called = true;
      return { ok: true, status: 200, json: async () => ({}) };
    });
    try {
      const { onAfterTool } = await loadEngineFresh();
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
      assert.equal(called, true, "backend audit endpoint should be hit");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("onAfterTool skips backend call if not configured", async () => {
  await withEnv({ ARMORIQ_API_KEY: undefined }, async () => {
    let called = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async () => {
      called = true;
      return { ok: true, status: 200, json: async () => ({}) };
    });
    try {
      const { onAfterTool } = await loadEngineFresh();
      const decision = await onAfterTool({
        ...basePayload,
        hook_event_name: "AfterTool",
        tool_name: "list_directory",
        tool_input: {}
      });
      assert.deepEqual(decision, {});
      assert.equal(called, false, "must not call backend without API key");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
