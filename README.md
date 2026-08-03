# ArmorGemini

ArmorIQ intent-based security enforcement for Gemini CLI. Enforces that AI agent tool calls match declared intent and workspace policy, and audits every call.

**Status:** v0.1.0. Local-only enforcement. Backend wiring (IAP tokens, CSRG proofs, dashboard) comes next.

## How It Works

Gemini CLI exposes lifecycle hooks (SessionStart, BeforeTool, AfterTool, SessionEnd, plus BeforeAgent/AfterAgent/BeforeModel/AfterModel). ArmorGemini registers on the four listed above:

```
User Prompt ──► SessionStart ──► session state init
                                     │
Tool Call ──► BeforeTool ──► policy check ──► allow / deny / hold
                                     │
Tool Result ──► AfterTool ──► sanitize + audit log
```

1. **BeforeTool (enforcement):** evaluates the pending tool call against local policy. Denies via Gemini's `decision: "deny"` and surfaces the reason and a badge back to the user.
2. **AfterTool (audit):** appends a sanitized record (secrets redacted, long strings truncated) to a daily JSONL audit log.
3. **SessionStart / SessionEnd:** session state hooks. Currently just log; used later for intent tokens.

## Install (local dev)

```bash
git clone git@github.com:armoriq/armorGemini.git
cd armorGemini
```

To enable in a Gemini CLI workspace, symlink or copy `.gemini/settings.json` into your project (or your `~/.gemini/settings.json` for global). The paths inside currently point at the checkout; a proper installer will land later.

## Configuration

Policy lives under `$ARMORGEMINI_DATA_DIR/policy.json`, defaulting to `~/.armoriq/armorgemini/policy.json`. First run seeds:

| Tool | Verb | Note |
|---|---|---|
| `read_file` | allow | read is safe |
| `list_directory` | allow | list is safe |
| `run_shell_command` | hold | shell requires approval |
| `write_file` | hold | writes require approval |
| `replace` | hold | replace requires approval |

Rule verbs: `allow`, `deny`, `hold`.

- `allow` lets the call through.
- `deny` returns Gemini a `decision: "deny"` with the rule's `note` as reason. Blocking is enforced.
- `hold` also returns `decision: "deny"` but frames the reason as an approval request. Retry after user confirmation.

Rules are matched by exact `tool_name` or `"*"` for the default rule. Regex + parameter matching coming later.

## Audit Logs

Every tool call (allowed, denied, held) appends a line to `$ARMORGEMINI_DATA_DIR/audit/YYYY-MM-DD.jsonl` with:

- `at` (ISO 8601)
- `session` (Gemini session id)
- `tool` (tool name)
- `input` (parameters, sanitized: secrets redacted, long strings truncated)
- `verdict` (allow / deny / hold)
- `rule` (matched rule id/verb/target, if any)

AfterTool entries additionally include `result_summary` from Gemini's `tool_response`.

## Tests

```bash
node --test tests/*.test.mjs
```

Two suites so far: policy engine, engine handlers. Uses a temp `ARMORGEMINI_DATA_DIR` per suite for hermeticity.

## Roadmap

- v0.1: local-only enforcement, seed policy, JSONL audit (this release)
- v0.2: `/armor` slash command surface via Gemini's prompt commands (parity with ArmorClaude)
- v0.3: policy templates (lockdown / strict-read-only / balanced / velocity-machine)
- v0.4: backend integration - intent tokens, CSRG proofs, dashboard visibility (shares ArmorIQ IAP with ArmorClaude / ArmorCodex)
- v0.5: intent-drift detection using Gemini's per-tool `description` field vs registered plan
- v0.6: distribution as a Gemini CLI extension

## Provenance

Based on the design of [ArmorClaude](https://github.com/armoriq/armorClaude). Feasibility spike results: Gemini CLI's `BeforeTool` hook confirmed to accept `decision: "deny"` and surface the reason plus `systemMessage` badge to the user. Payload richness matches ArmorClaude, plus Gemini gives us a per-tool-call `description` field (Gemini's own reasoning about why it wants to run the tool) that ArmorClaude has to reconstruct from the plan file.

## License

MIT
