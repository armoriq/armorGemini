# ArmorGemini

ArmorIQ intent-based security enforcement for Gemini CLI. Registers on Gemini's lifecycle hooks and enforces workspace policy on every tool call.

**Status:** v0.2.0. Backend-authoritative. Requires an ArmorIQ API key.

## Design

ArmorGemini is **backend-only**: every enforcement decision and every audit record flows through the ArmorIQ IAP backend. There is no local policy fallback and no local audit persistence. If the plugin is not configured with an API key, hooks fail closed and every tool call is denied with a clear "not configured" message.

```
User Prompt ──► SessionStart hook
                                                             │
Tool Call ──► BeforeTool hook ──► POST /iap/verify-step ──► allow | deny
                                                             │
Tool Result ──► AfterTool hook ──► POST /iap/audit (best-effort)
```

## Install

```bash
git clone git@github.com:armoriq/armorGemini.git
cd armorGemini
```

Copy or symlink `.gemini/settings.json` into your project (or `~/.gemini/settings.json` for global). Adjust the absolute paths inside so they point at your checkout; the packaged extension in v0.6 will handle path resolution.

## Configuration

ArmorGemini reads these environment variables:

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `ARMORIQ_API_KEY` | Yes | - | Your ArmorIQ API key. Missing = fail-closed. |
| `ARMORIQ_BACKEND_ENDPOINT` | No | `https://api.armoriq.ai` | Override for dev or self-hosted backends. |
| `ARMORIQ_ORG_ID` | No | - | Scope the plugin to a specific ArmorIQ org. |
| `ARMORGEMINI_TIMEOUT_MS` | No | `8000` | Per-request timeout to the backend. |

Get a key at https://armoriq.ai.

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
| `BeforeTool` | Calls `POST /iap/verify-step` with tool name, input, session id, and Gemini's per-tool `description`. Returns `decision: "deny"` with the backend's reason if disallowed. |
| `AfterTool` | Sanitizes input (redacts obvious secret-shaped keys, truncates long strings), then best-effort `POST /iap/audit`. Never blocks. |
| `SessionEnd` | Logs session end. |

## Tests

```bash
node --test tests/*.test.mjs
```

Tests stub `globalThis.fetch` per case to simulate backend responses (allow, deny, 401, network error). No real network is hit.

## Roadmap

- **v0.1** - local-mode spike (superseded).
- **v0.2** - backend-only + /armor slash commands (this release).
- **v0.3** - policy templates surfaced through /armor:template with dashboard-side template library.
- **v0.4** - signed intent tokens + CSRG proofs.
- **v0.5** - intent-drift detection using Gemini's per-tool `description` field vs the registered plan.
- **v0.6** - packaged as a Gemini CLI extension for one-command install.

## Provenance

Ports the ArmorClaude enforcement model to Gemini CLI. Feasibility spike results: Gemini CLI's `BeforeTool` accepts `decision: "deny"` and surfaces both the reason and a `systemMessage` badge to the user; `AfterTool` gives us the full `tool_response` including LLM-facing content and display metadata. Gemini also exposes a per-tool-call `description` field (the model's own reasoning about the call) that gives us a second signal for intent-drift detection.

## License

MIT
