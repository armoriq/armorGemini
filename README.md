# ArmorGemini

ArmorIQ intent-based security enforcement for Gemini CLI. Every tool call is checked against a per-turn intent plan AND your ArmorIQ workspace policy before it runs.

**Status:** v0.3.0. Real intent-plan enforcement via a bundled MCP server. Requires an ArmorIQ API key.

## Design

ArmorGemini is **backend-authoritative for policy** and **local-first for intent drift**. Every enforcement decision that catches drift fires client-side without waiting on the network; every policy decision flows through the ArmorIQ IAP backend. If the plugin is not configured with an API key, hooks fail closed and every tool call is denied with a clear "not configured" message.

```
User Prompt ──► SessionStart hook             (banner: ENFORCING)
                       │
                       ▼
                BeforeAgent hook               (inject "declare your plan first" directive)
                       │
                       ▼
                Model calls register_intent_plan (armorgemini-policy MCP tool)
                       │
                       ▼
                BeforeToolSelection hook        (whitelist the model's tool surface to just the plan)
                       │
                       ▼
Tool Call ──► BeforeTool hook  ──► 1. is tool in plan?          (drift check, local, no network)
                                    2. is plan still fresh?      (TTL)
                                    3. POST /iap/enforce         (policy check, backend)
                       │
                       ▼
                allow | deny
                       │
                       ▼
Tool Result ──► AfterTool hook  ──► POST /iap/audit (best-effort)
                       │
                       ▼
                SessionEnd hook                 (clear the plan file)
```

## Install

One-command install (writes global Gemini CLI settings, installs the ArmorIQ SDK/CLI, and prompts you to sign in):

```bash
curl -fsSL https://armoriq.ai/install_armorgemini.sh | bash
```

The installer:

1. Installs `@armoriq/sdk` globally (adds the `armoriq` CLI to your PATH)
2. Downloads the plugin into `~/.armoriq/armorGemini`
3. Wires the six ArmorGemini hooks into `~/.gemini/settings.json`
4. Wires the `armorgemini-policy` MCP server via `gemini-extension.json`
5. Registers the `/armor:*` slash commands in `~/.gemini/commands/armor/`
6. Runs `armoriq login --product armorgemini` which opens your browser, mints an API key, and writes it to `~/.armoriq/credentials.json`
7. Verifies the hooks fire

After that first run there is nothing more to do. The plugin picks up the key from `~/.armoriq/credentials.json` on every subsequent Gemini CLI session.

### Manual credential controls (dev / advanced)

End users should not need these. For local dev or CI:

| Variable | Purpose |
|---|---|
| `ARMORIQ_API_KEY` | Override the credentials.json key. Precedence: env > credentials.json. |
| `ARMORIQ_BACKEND_ENDPOINT` | Override backend URL. Default `https://api.armoriq.ai`. |
| `ARMORIQ_ORG_ID` | Scope the plugin to a specific ArmorIQ org. |
| `ARMORGEMINI_TIMEOUT_MS` | Per-request timeout to the backend (default 8000). |
| `ARMORGEMINI_DATA_DIR` | Where per-session plan files live. Default `~/.gemini/armorgemini`. |
| `ARMORGEMINI_INTENT_REQUIRED` | Set to `false` to disable intent-plan enforcement and fall back to policy-only mode (v0.2 behavior). |
| `ARMORGEMINI_PLAN_TTL_SECONDS` | Age (in seconds) after which a stored plan is treated as stale. Default 600. |

### Reconnecting or switching accounts

```bash
armoriq login --product armorgemini    # re-runs the browser auth, overwrites credentials.json
armoriq logout                          # clears credentials.json
```

## The `armorgemini-policy` MCP server

Bundled with the plugin, declared in `gemini-extension.json` under `mcpServers`. Gemini CLI launches it automatically on session start. Three tools:

| Tool | Purpose |
|---|---|
| `register_intent_plan` | Declare your plan for the current turn. Must be called before any other tool when `ARMORGEMINI_INTENT_REQUIRED=true` (the default). |
| `reset_intent_plan` | Clear the current plan explicitly. The next tool call will be denied until a fresh plan is registered. |
| `get_intent_plan` | Read the currently registered plan for a session. Informational. |

The plan shape:

```json
{
  "goal": "One-line summary of the task",
  "steps": [
    { "action": "read_file", "description": "Peek at the top of README" },
    { "action": "list_directory", "description": "See what else is in the dir" }
  ]
}
```

Tools listed in `steps[].action` are allowed for the rest of the turn. Anything else is denied at BeforeTool as intent drift.

## The `/armor` slash commands

Installed alongside the hooks. All commands stage proposals on the ArmorIQ dashboard - a human confirms them there before they take effect.

| Command | Purpose |
|---|---|
| `/armor:list` | Show the current policy for this workspace. |
| `/armor:add <verb> <target> [note]` | Stage a rule change. Verb: `allow`, `deny`, or `hold`. |
| `/armor:template <name>` | Stage a named policy template (lockdown, strict-read-only, balanced, ...). |
| `/armor:help` | Show help. |

Examples:

```
/armor:list
/armor:add deny web_fetch external network is not allowed here
/armor:template lockdown
```

## Hook lifecycle

| Hook | What ArmorGemini does |
|---|---|
| `SessionStart` | Logs session_id, cwd, and configured state. Prints the ENFORCING banner. |
| `BeforeAgent` | Injects a directive telling the model to call `register_intent_plan` (armorgemini-policy MCP) before any other tool. |
| `BeforeToolSelection` | Whitelists the model's tool surface to just the plan (plus the plan-management tools). Structural: the model literally cannot see off-plan tools when it decides. |
| `BeforeTool` | Two layers: (1) intent-drift check against the registered plan, (2) policy check via `POST /iap/enforce`. Either failing → deny. |
| `AfterTool` | Sanitizes input (redacts obvious secret-shaped keys, truncates long strings), then best-effort `POST /iap/audit`. Never blocks. |
| `SessionEnd` | Clears the session's plan file. |

## Tests

```bash
node --test tests/*.test.mjs
```

Tests stub `globalThis.fetch` per case to simulate backend responses (allow, deny, 401, network error), and use a scratch data dir to exercise the intent-plan path without touching real state. No real network is hit.

## Provenance

Ports the ArmorClaude enforcement model to Gemini CLI. Gemini CLI's hook set is a superset of what Claude Code exposes: `BeforeAgent` is the per-turn hook (equivalent of Claude's `UserPromptSubmit`), `BeforeToolSelection` is a bonus tightening layer that Claude Code doesn't have (structurally hides off-plan tools from the model). The plugin bundles a stdio MCP server declared via `mcpServers` in the `gemini-extension.json` manifest, so intent-plan capture works natively without shell-side hacks.

## License

MIT
