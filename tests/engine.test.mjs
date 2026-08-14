import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// ArmorGemini is backend-only: engine tests set/clear env for the API key
// and stub globalThis.fetch to simulate backend responses. Tests that must
// see "not configured" set ARMORGEMINI_SKIP_CREDS_FILE=1 so the resolver
// ignores the developer machine's real ~/.armoriq/credentials.json.
//
// v0.3 tests also exercise the intent-plan flow: they write a plan file
// into a scratch data dir and assert BeforeTool denies drift.

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

function makeScratchDataDir() {
  return mkdtempSync(path.join(tmpdir(), "armorgemini-test-"));
}

function writePlan(dataDir, sessionId, plan) {
  const dir = path.join(dataDir, "plans");
  mkdirSync(dir, { recursive: true });
  const record = {
    session_id: sessionId,
    registered_at: new Date().toISOString(),
    goal: plan.goal,
    steps: plan.steps
  };
  writeFileSync(path.join(dir, `${sessionId}.json`), JSON.stringify(record));
}

// ---------------------------------------------------------------------------
// Baseline (v0.2 behavior preserved via ARMORGEMINI_INTENT_REQUIRED=false)
// ---------------------------------------------------------------------------

test("onBeforeTool DENIES every tool when ARMORIQ_API_KEY is missing (fail-closed)", async () => {
  await withEnv(
    {
      ARMORIQ_API_KEY: undefined,
      ARMORGEMINI_API_KEY: undefined,
      ARMORGEMINI_SKIP_CREDS_FILE: "1"
    },
    async () => {
      const { onBeforeTool } = await loadEngineFresh();
      const decision = await onBeforeTool({
        ...basePayload,
        tool_name: "read_file",
        tool_input: { path: "README.md" }
      });
      assert.equal(decision.decision, "deny");
      assert.match(decision.reason, /armoriq login/i);
      assert.match(decision.systemMessage, /not connected/);
    }
  );
});

test("onBeforeTool (policy-only mode) ALLOWS when backend returns allowed=true", async () => {
  await withEnv({ ARMORIQ_API_KEY: "test-key", ARMORGEMINI_INTENT_REQUIRED: "false" }, async () => {
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

test("onBeforeTool (policy-only mode) DENIES when backend returns allowed=false", async () => {
  await withEnv({ ARMORIQ_API_KEY: "test-key", ARMORGEMINI_INTENT_REQUIRED: "false" }, async () => {
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

test("onBeforeTool (policy-only mode) FATAL deny on 401 auth error", async () => {
  await withEnv({ ARMORIQ_API_KEY: "wrong-key", ARMORGEMINI_INTENT_REQUIRED: "false" }, async () => {
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

test("onBeforeTool (policy-only mode) DENIES fail-closed on backend network error", async () => {
  await withEnv({ ARMORIQ_API_KEY: "test-key", ARMORGEMINI_INTENT_REQUIRED: "false" }, async () => {
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
  await withEnv(
    { ARMORIQ_API_KEY: undefined, ARMORGEMINI_SKIP_CREDS_FILE: "1" },
    async () => {
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
    }
  );
});

// ---------------------------------------------------------------------------
// v0.3 intent-plan enforcement
// ---------------------------------------------------------------------------

test("v0.3 onBeforeTool DENIES when no plan is registered (intent-required default)", async () => {
  const dataDir = makeScratchDataDir();
  try {
    await withEnv(
      {
        ARMORIQ_API_KEY: "test-key",
        ARMORGEMINI_DATA_DIR: dataDir,
        ARMORGEMINI_INTENT_REQUIRED: "true"
      },
      async () => {
        // Fetch should NEVER be called: the plan check fires first and
        // denies before we ever reach the backend.
        const originalFetch = globalThis.fetch;
        let fetchCalled = false;
        globalThis.fetch = mock.fn(async () => {
          fetchCalled = true;
          return { ok: true, status: 200, json: async () => ({ allowed: true }) };
        });
        try {
          const { onBeforeTool } = await loadEngineFresh();
          const decision = await onBeforeTool({
            ...basePayload,
            tool_name: "read_file",
            tool_input: { path: "README.md" }
          });
          assert.equal(decision.decision, "deny");
          assert.match(decision.reason, /no intent plan registered/i);
          assert.match(decision.systemMessage, /no plan registered/);
          assert.equal(fetchCalled, false, "backend must NOT be hit when the plan check has already denied");
        } finally {
          globalThis.fetch = originalFetch;
        }
      }
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("v0.3 onBeforeTool ALLOWS a tool that is present in the registered plan (and backend allows)", async () => {
  const dataDir = makeScratchDataDir();
  writePlan(dataDir, "test-session", {
    goal: "Read the README",
    steps: [{ action: "read_file", description: "Peek at the top of README" }]
  });
  try {
    await withEnv({ ARMORIQ_API_KEY: "test-key", ARMORGEMINI_DATA_DIR: dataDir }, async () => {
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
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("v0.3 onBeforeTool DENIES a tool NOT in the registered plan (intent drift)", async () => {
  const dataDir = makeScratchDataDir();
  writePlan(dataDir, "test-session", {
    goal: "Read the README",
    steps: [{ action: "read_file", description: "Peek at the top of README" }]
  });
  try {
    await withEnv({ ARMORIQ_API_KEY: "test-key", ARMORGEMINI_DATA_DIR: dataDir }, async () => {
      let fetchCalled = false;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock.fn(async () => {
        fetchCalled = true;
        return { ok: true, status: 200, json: async () => ({ allowed: true }) };
      });
      try {
        const { onBeforeTool } = await loadEngineFresh();
        const decision = await onBeforeTool({
          ...basePayload,
          tool_name: "web_fetch",
          tool_input: { url: "https://example.com" }
        });
        assert.equal(decision.decision, "deny");
        assert.match(decision.reason, /intent drift/i);
        assert.match(decision.systemMessage, /intent drift/i);
        assert.equal(fetchCalled, false, "backend must NOT be hit when drift is caught client-side");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("v0.3 onBeforeAgent injects the register_intent_plan directive with session_id", async () => {
  await withEnv({ ARMORIQ_API_KEY: "test-key", ARMORGEMINI_INTENT_REQUIRED: "true" }, async () => {
    const { onBeforeAgent } = await loadEngineFresh();
    const decision = await onBeforeAgent({
      ...basePayload,
      hook_event_name: "BeforeAgent",
      prompt: "Show me README.md"
    });
    const ctx = decision?.hookSpecificOutput?.additionalContext || "";
    assert.match(ctx, /register_intent_plan/);
    assert.match(ctx, /test-session/);
    assert.match(ctx, /"goal"/);
    assert.match(ctx, /"steps"/);
  });
});

test("v0.3 onBeforeAgent injects NOTHING in policy-only mode", async () => {
  await withEnv({ ARMORIQ_API_KEY: "test-key", ARMORGEMINI_INTENT_REQUIRED: "false" }, async () => {
    const { onBeforeAgent } = await loadEngineFresh();
    const decision = await onBeforeAgent({
      ...basePayload,
      hook_event_name: "BeforeAgent",
      prompt: "Show me README.md"
    });
    assert.deepEqual(decision, {});
  });
});

test("v0.3 onBeforeToolSelection whitelists only the armorgemini-policy tools when no plan yet", async () => {
  const dataDir = makeScratchDataDir();
  try {
    await withEnv({ ARMORIQ_API_KEY: "test-key", ARMORGEMINI_DATA_DIR: dataDir }, async () => {
      const { onBeforeToolSelection } = await loadEngineFresh();
      const decision = await onBeforeToolSelection({
        ...basePayload,
        hook_event_name: "BeforeToolSelection"
      });
      const allowed = decision?.hookSpecificOutput?.toolConfig?.allowedFunctionNames;
      assert.ok(Array.isArray(allowed));
      assert.ok(allowed.includes("register_intent_plan"));
      assert.ok(!allowed.includes("read_file"), "no plan → only the plan-management tools should be whitelisted");
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("v0.3 onBeforeToolSelection whitelists plan tools + policy tools when a plan exists", async () => {
  const dataDir = makeScratchDataDir();
  writePlan(dataDir, "test-session", {
    goal: "Read README then list dir",
    steps: [
      { action: "read_file" },
      { action: "list_directory" }
    ]
  });
  try {
    await withEnv({ ARMORIQ_API_KEY: "test-key", ARMORGEMINI_DATA_DIR: dataDir }, async () => {
      const { onBeforeToolSelection } = await loadEngineFresh();
      const decision = await onBeforeToolSelection({
        ...basePayload,
        hook_event_name: "BeforeToolSelection"
      });
      const allowed = decision?.hookSpecificOutput?.toolConfig?.allowedFunctionNames;
      assert.ok(Array.isArray(allowed));
      assert.ok(allowed.includes("read_file"));
      assert.ok(allowed.includes("list_directory"));
      assert.ok(allowed.includes("register_intent_plan"), "armorgemini-policy tools always in the whitelist");
      assert.ok(!allowed.includes("web_fetch"), "off-plan tools must not appear in the whitelist");
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
