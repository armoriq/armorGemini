import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// loadConfig reads ~/.armoriq/credentials.json through os.homedir(), which honours
// HOME on POSIX, so each case runs against a throwaway home.
async function withHome(credentials, fn) {
  const home = mkdtempSync(path.join(tmpdir(), "armorgemini-config-"));
  const previousHome = process.env.HOME;
  const previousSkip = process.env.ARMORGEMINI_SKIP_CREDS_FILE;
  const previousKey = process.env.ARMORIQ_API_KEY;
  const previousProductKey = process.env.ARMORGEMINI_API_KEY;
  const previousEndpoint = process.env.ARMORIQ_BACKEND_ENDPOINT;
  try {
    mkdirSync(path.join(home, ".armoriq"), { recursive: true });
    if (credentials !== null) {
      writeFileSync(
        path.join(home, ".armoriq", "credentials.json"),
        JSON.stringify(credentials)
      );
    }
    process.env.HOME = home;
    delete process.env.ARMORGEMINI_SKIP_CREDS_FILE;
    delete process.env.ARMORIQ_API_KEY;
    delete process.env.ARMORGEMINI_API_KEY;
    delete process.env.ARMORIQ_BACKEND_ENDPOINT;
    // Imported per case: loadConfig reads the environment at call time, but a
    // fresh specifier keeps a case from inheriting module state from another.
    const { loadConfig } = await import(
      `../scripts/lib/config.mjs?case=${encodeURIComponent(home)}`
    );
    await fn(loadConfig);
  } finally {
    restore("HOME", previousHome);
    restore("ARMORGEMINI_SKIP_CREDS_FILE", previousSkip);
    restore("ARMORIQ_API_KEY", previousKey);
    restore("ARMORGEMINI_API_KEY", previousProductKey);
    restore("ARMORIQ_BACKEND_ENDPOINT", previousEndpoint);
    rmSync(home, { recursive: true, force: true });
  }
}

function restore(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

const profile = (product, backend, apiKey) => ({
  backend,
  product,
  apiKey,
  email: "user@example.com",
  userId: "11111111-1111-1111-1111-111111111111",
  orgId: "22222222-2222-2222-2222-222222222222",
  loggedInAt: "2026-11-01T00:00:00.000Z",
  savedAt: "2026-11-01T00:00:00.000Z"
});

test("v2 profile store: the armorgemini profile is used", async () => {
  await withHome(
    {
      version: 2,
      active: "armorclaude@api.armoriq.ai",
      profiles: {
        "armorclaude@api.armoriq.ai": profile(
          "armorclaude",
          "https://api.armoriq.ai",
          "ak_live_claude"
        ),
        "armorgemini@staging-api.armoriq.ai": profile(
          "armorgemini",
          "https://staging-api.armoriq.ai",
          "ak_live_gemini"
        )
      }
    },
    (loadConfig) => {
      const config = loadConfig();
      assert.equal(config.apiKey, "ak_live_gemini");
      assert.equal(config.backendEndpoint, "https://staging-api.armoriq.ai");
      assert.equal(config.isConfigured, true);
      assert.equal(config.credentialSource, "credentials.json");
    }
  );
});

test("v2 profile store: falls back to the active profile of another product", async () => {
  await withHome(
    {
      version: 2,
      active: "armorcodex@staging-api.armoriq.ai",
      profiles: {
        "armorclaude@api.armoriq.ai": profile(
          "armorclaude",
          "https://api.armoriq.ai",
          "ak_live_claude"
        ),
        "armorcodex@staging-api.armoriq.ai": profile(
          "armorcodex",
          "https://staging-api.armoriq.ai",
          "ak_live_codex"
        )
      }
    },
    (loadConfig) => {
      const config = loadConfig();
      assert.equal(config.apiKey, "ak_live_codex");
      assert.equal(config.backendEndpoint, "https://staging-api.armoriq.ai");
      assert.equal(config.isConfigured, true);
    }
  );
});

test("v1 flat credentials still load", async () => {
  await withHome(
    {
      apiKey: "ak_live_flat",
      backendEndpoint: "https://api.armoriq.ai",
      orgId: "22222222-2222-2222-2222-222222222222"
    },
    (loadConfig) => {
      const config = loadConfig();
      assert.equal(config.apiKey, "ak_live_flat");
      assert.equal(config.backendEndpoint, "https://api.armoriq.ai");
      assert.equal(config.isConfigured, true);
    }
  );
});

test("an empty profile store stays unconfigured", async () => {
  await withHome({ version: 2, active: null, profiles: {} }, (loadConfig) => {
    const config = loadConfig();
    assert.equal(config.apiKey, "");
    assert.equal(config.isConfigured, false);
    assert.equal(config.credentialSource, "none");
  });
});
