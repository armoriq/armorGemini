# ArmorGemini

ArmorIQ intent-based security enforcement for Gemini CLI. Registers on Gemini's lifecycle hooks and enforces workspace policy on every tool call.

**Status:** v0.2.0. Backend-authoritative. Requires an ArmorIQ API key.

## Design

ArmorGemini is **backend-only**: every enforcement decision and every audit record flows through the ArmorIQ IAP backend. There is no local policy fallback and no local audit persistence. If the plugin is not configured with an API key, hooks fail closed and every tool call is denied with a clear "not configured" message.

```
User Prompt ──► SessionStart hook
                                                             │
Tool Call ──► BeforeTool hook ──► POST /iap/enforce ──► allow | deny
                                                             │
Tool Result ──► AfterTool hook ──► POST /iap/audit (best-effort)
```

## Install

One-command install (writes global Gemini CLI settings, installs the ArmorIQ SDK/CLI, and prompts you to sign in):

```bash
curl -fsSL https://armoriq.ai/install_armorgemini.sh | bash
```

The installer:

1. Installs `@armoriq/sdk` globally (adds the `armoriq` CLI to your PATH)
2. Downloads the plugin into `~/.armoriq/armorGemini`
3. Wires ArmorGemini's hooks into `~/.gemini/settings.json`
4. Registers the `/armor:*` slash commands in `~/.gemini/commands/armor/`
5. Runs `armoriq login --product armorgemini` which opens your browser, mints an API key, and writes it to `~/.armoriq/credentials.json`
6. Verifies the hook fires

After that first run there is nothing more to do. The plugin picks up the key from `~/.armoriq/credentials.json` on every subsequent Gemini CLI session.

### Manual credential controls (dev / advanced)

End users should not need these. For local dev or CI:

| Variable | Purpose |
|---|---|
| `ARMORIQ_API_KEY` | Override the credentials.json key. Precedence: env > credentials.json. |
| `ARMORIQ_BACKEND_ENDPOINT` | Override backend URL. Default `https://api.armoriq.ai`. |
| `ARMORIQ_ORG_ID` | Scope the plugin to a specific ArmorIQ org. |
| `ARMORGEMINI_TIMEOUT_MS` | Per-request timeout to the backend (default 8000). |

### Reconnecting or switching accounts

```bash
armoriq login --product armorgemini    # re-runs the browser auth, overwrites credentials.json
armoriq logout                          # clears credentials.json
```

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
| `SessionStart` | Logs session_id, cwd, and configured state. |
| `BeforeTool` | Calls `POST /iap/enforce` with tool name, input, session id, and Gemini's per-tool `description`. Returns `decision: "deny"` with the backend's reason if disallowed. |
| `AfterTool` | Sanitizes input (redacts obvious secret-shaped keys, truncates long strings), then best-effort `POST /iap/audit`. Never blocks. |
| `SessionEnd` | Logs session end. |

## Tests

```bash
node --test tests/*.test.mjs
```

Tests stub `globalThis.fetch` per case to simulate backend responses (allow, deny, 401, network error). No real network is hit.

## Provenance

Ports the ArmorClaude enforcement model to Gemini CLI. Feasibility spike results: Gemini CLI's `BeforeTool` accepts `decision: "deny"` and surfaces both the reason and a `systemMessage` badge to the user; `AfterTool` gives us the full `tool_response` including LLM-facing content and display metadata. Gemini also exposes a per-tool-call `description` field (the model's own reasoning about the call) that gives us a second signal for intent-drift detection.

## License

MIT
