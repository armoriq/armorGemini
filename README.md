# ArmorGemini

ArmorIQ intent-based security enforcement plugin for the Gemini CLI. Enforces that Gemini declares what it intends to do before doing it, and every action is checked against that declared intent.

**Status:** v0.3.2. Intent-plan enforcement via a bundled MCP server, local-first policy activation (`/armor:yes` is the only confirmation), backend policy layer on top for org-wide rules. Requires an ArmorIQ API key. See [CHANGELOG](CHANGELOG.md) for what changed.

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
                                    3. local policy match?       (${dataDir}/policy.json, no network)
                                    4. POST /iap/enforce         (backend policy check)
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

Installed alongside the hooks. `/armor:add` and `/armor:template` stage the policy locally with a YAML preview; `/armor:yes` activates it and enforcement kicks in immediately on this session. No dashboard round-trip.

| Command | Purpose |
|---|---|
| `/armor:list` | Show the current active local policy. |
| `/armor:add <verb> <target> [note]` | Stage a rule change (verb: `allow`, `deny`, or `hold`). Shows a YAML preview. |
| `/armor:template <name>` | Stage a named policy template (`lockdown`, `strict-read-only`, `balanced`). Shows a YAML preview. |
| `/armor:yes` | Confirm the currently staged proposal. Writes it to `${dataDir}/policy.json` (`BeforeTool` picks it up immediately) and fire-and-forgets the same policy to the ArmorIQ backend for audit. |
| `/armor:no` | Discard the currently staged proposal. |
| `/armor:help` | Show help. |

Example flow:

```
/armor:add deny web_fetch external network not allowed here
    (YAML preview appears, nothing sent anywhere)
/armor:yes
    (local policy.json written, enforcement live, backend audit push best-effort)
/armor:list
    (shows the new rule)
```

## Hook lifecycle

| Hook | What ArmorGemini does |
|---|---|
| `SessionStart` | Logs session_id, cwd, and configured state. Prints the ENFORCING banner. |
| `BeforeAgent` | Injects a directive telling the model to call `register_intent_plan` (armorgemini-policy MCP) before any other tool. |
| `BeforeToolSelection` | No-op today. Gemini API rejects `allowedFunctionNames` with `mode: "AUTO"`, and `mode: "ANY"` forces tool calls on every turn. Enforcement stays in `BeforeTool`. |
| `BeforeTool` | Layered enforcement: (1) intent-drift check against the registered plan, (2) local policy check against `${dataDir}/policy.json` (source of truth for enforcement, written by `/armor:yes`), (3) backend `POST /iap/enforce` for org-wide policy. Any layer denying → deny. |
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
