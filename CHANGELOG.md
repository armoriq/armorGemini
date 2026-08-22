# Changelog

All notable changes to ArmorGemini are documented in this file. Dates are ISO YYYY-MM-DD.

## 0.3.3 — 2026-08-22

### Changed

- **Migrated to the standard Gemini CLI extension layout.** ArmorGemini now ships hooks, commands, and a context file in the locations Gemini CLI's extension loader natively discovers, so `gemini extensions install armoriq/armorGemini` (or `gemini extensions link .`) wires up the plugin without the installer script needing to hand-merge anything into `~/.gemini/settings.json`. Concretely: `hooks/hooks.json` (six-hook block, `${extensionPath}` substitutions), `commands/armor/*.toml` (six slash commands, `${extensionPath}` substitutions), and `GEMINI.md` with a matching `contextFileName` entry in the manifest. `gemini extensions validate` accepts the layout.
- **`gemini-extension.json` now declares `contextFileName: "GEMINI.md"`.** The context file is a compact, session-persistent restatement of the intent-plan rule and the `/armor` command surface. It complements the per-turn `BeforeAgent` directive, which provides the dynamic session ID required to register a plan.
- Bumped `package.json` and `gemini-extension.json` to `0.3.3`.

### Fixed

- **geminicli.com catalog badges.** Previously the card at [geminicli.com/extensions](https://geminicli.com/extensions/browse/) showed only an "MCP" badge because that was the only capability declared in `gemini-extension.json`. Everything else the plugin does (hooks, `/armor` slash commands) was applied by our installer script's post-install steps, not exposed through the standard extension layout, so the crawler could not see it. With the new layout the card now shows "MCP + Hooks + Commands + Context file" (four badges), which is what an extension of this shape should look like.

### Compatibility

- The legacy `.gemini/settings.json` and `.gemini/commands/armor/` files are still shipped in the repo so previously-released installers keep working during the rollout. They will be removed once `install_armorgemini.sh` on the landing has been updated to rely on `gemini extensions link` exclusively.

## 0.3.2 — 2026-08-17

### Changed

- **Tagline aligned with ArmorClaude.** README, `package.json` description, `gemini-extension.json` description, and the GitHub repo About all now lead with "ArmorIQ intent-based security enforcement for the Gemini CLI. Enforces that Gemini declares what it intends to do before doing it, and every action is checked against that declared intent." The previous framing described policy checking as if that were the headline feature; intent enforcement is what the plugin is actually for.

### Added

- **`/armor:yes` is now the only confirmation.** Approving a staged proposal writes the confirmed policy to `${dataDir}/policy.json` and activates it on the current Gemini CLI session immediately, then fire-and-forgets the same policy to the ArmorIQ backend for audit and fleet propagation. The ArmorIQ dashboard is no longer part of the confirm path.
- **Local policy evaluation layer** in `BeforeTool`. When `${dataDir}/policy.json` is present, the plugin evaluates the tool call against it before the backend `POST /iap/enforce` hop. A local deny short-circuits the network call and blocks the tool in single-digit milliseconds.
- **`scripts/lib/local-policy.mjs`** — `saveActivePolicy`, `readActivePolicy`, `hasActivePolicy`, `evaluateLocalPolicy`. Walks statements in order, matches `action.eq` case-insensitively against the normalized Gemini→backend tool name, honors `defaults.decision` and `deny_overrides` conflict resolution.
- **6 new unit tests** in `tests/local-policy.test.mjs` covering save/read round-trip, Gemini→Claude tool-name matching, default-allow fall-through, wildcard lockdown, null-policy is-allow, and permit+forbid conflict resolution.

### Changed

- `/armor:list` now reads from the local active policy file. That's the source of truth for enforcement, so it's what users actually experience at `BeforeTool` time. The previous behavior (a `GET /policies/profiles/active` round-trip) reflected fleet-level policy which drifts from local until the backend push is confirmed by the workspace owner.
- `/armor:list` output shape: shows `metadata.name` + `defaults.decision` at the top, then each statement as `[id] effect action.eq - description`.

### Fixed

- **BeforeToolSelection is a no-op.** Gemini API rejects `allowedFunctionNames` when `mode: "AUTO"`; the whitelist requires `mode: "ANY"`, which forces the model to call a tool on every turn and breaks plain-text replies. Enforcement stays in `BeforeTool` where it already caught drift correctly.
- **Gemini-namespaced MCP tools recognized.** Gemini CLI exposes MCP tools as `mcp_<server>_<tool>` (single underscores). The plan-management allowlist was looking for Claude Code's `mcp__<server>__<tool>` (double underscore) convention only. Both conventions plus bare tool names now match.
- **`/policies/profiles/draft` payload shape** matches the backend's `armor.policy.v1` PolicyProfile validator: `permit`/`forbid` effects, typed `principal` / `action` / `resource` objects, `conditions` array. No more `HTTP 400 property source should not exist`.
- **Gemini→backend tool-name mapping.** The backend's `KNOWN_TOOLS` registry is Claude-CLI-specific (`WebFetch`, `Read`, `Bash`, `Glob`, `Grep`, ...). `scripts/lib/backend-client.mjs` now maps Gemini names (`web_fetch`, `read_file`, `run_shell_command`, `glob`, `search_file_content`, ...) to the accepted equivalents at draft time. Long-term this belongs on the backend.
- **`fetchPolicy` uses the API-key-authed endpoint.** Switched from `/policies/current` (JWT-only, was 401ing) to `/policies/profiles/active`, and parses the returned PolicyProfile into a flat rule list.

## 0.3.1 — 2026-08-16

### Added

- **Stage-then-`/armor:yes` UX.** `/armor:add` and `/armor:template` no longer push to the backend directly. They stage the built `PolicyProfile` at `${dataDir}/policy-pending.json` and print a YAML preview of the exact policy the plugin will send. Nothing hits the network until the user runs `/armor:yes` (or `/armor:no` to discard).
- **`/armor:yes` and `/armor:no`** slash commands. `.gemini/commands/armor/yes.toml` and `.gemini/commands/armor/no.toml` shipped alongside `add`/`template`/`list`/`help`.
- **YAML preview** rendered by a hand-rolled dumper in `scripts/lib/policy-yaml.mjs`. Dependency-free so `scripts/policy-mcp.mjs` can import the schema module without pulling the SDK.
- **Pending proposal storage** in `scripts/lib/pending.mjs`. Single pending proposal per workspace, 30-minute TTL, cleared on `/armor:yes` after successful push or on `/armor:no`.
- **6 new unit tests** in `tests/pending.test.mjs` covering stage/read/clear/overwrite, YAML render, and template shape.

## 0.3.0 — 2026-08-14

### Added

- **Intent-plan enforcement.** Ports ArmorClaude's model to Gemini CLI using the 11-hook set Google actually ships (not the 4 assumed in v0.2). Six hooks are wired: `SessionStart`, `BeforeAgent`, `BeforeToolSelection`, `BeforeTool`, `AfterTool`, `SessionEnd`.
- **`BeforeAgent` directive injection.** Per-turn hook that appends a directive telling the model to call `register_intent_plan` (via the bundled MCP server) before any other tool, with the current `session_id` inline for the model to echo back.
- **Bundled `armorgemini-policy` MCP server.** `scripts/policy-mcp.mjs` exposes `register_intent_plan`, `reset_intent_plan`, `get_intent_plan`. Declared in `gemini-extension.json` under `mcpServers` so `gemini extensions install ...` picks it up natively. Uses `@modelcontextprotocol/sdk` stdio transport.
- **Per-session plan storage** in `scripts/lib/planner.mjs`. One JSON file per session at `${dataDir}/plans/${session_id}.json`. Cleaned on `SessionEnd`.
- **Two-layer `BeforeTool`.** Layer 1 (client-side intent-drift check): tool must be in the registered plan and the plan must be within TTL. Layer 2 (backend policy check): `POST /iap/enforce`.
- **Config knobs.** `ARMORGEMINI_DATA_DIR`, `ARMORGEMINI_INTENT_REQUIRED` (default `true`, set `false` to fall back to v0.2 policy-only mode), `ARMORGEMINI_PLAN_TTL_SECONDS` (default `600`).
- **Test-only escape hatch** `ARMORGEMINI_SKIP_CREDS_FILE=1` so fail-closed asserts hold on a developer machine that has a real `~/.armoriq/credentials.json`.

### Changed

- `verifyStep` calls `POST /iap/enforce` (the policy-evaluation endpoint the SDK exposes as `armoriq check`), not `POST /iap/verify-step` (the CSRG-Merkle-proof path that requires a pre-registered signed intent token). Fixes the fail-closed cascade that blocked every tool in v0.2.
- SessionStart banner reports the current mode (`ENFORCING · intent required` or `ENFORCING · policy only`).
- On the ALLOW path, `BeforeTool` now returns a `systemMessage` naming the tool and the matched policy (or "no matching policy"). The plugin is visible on the happy path, not just on deny.
- Dependencies added: `@modelcontextprotocol/sdk ^1.0.4`, `zod ^3.23.8`.

## 0.2.1 — 2026-08-07

### Fixed

- Sanitized developer-machine paths from the shipped `.gemini/settings.json` and `.gemini/commands/armor/*.toml`. Replaced `/Users/<user>/Armoriq/armorGemini` with the `__ARMORGEMINI_HOME__` template marker. Requires a matching installer update in `armoriq-landing` (`install_armorgemini.sh`) to substitute the new placeholder alongside the legacy pattern for backward compat.

## 0.2.0 — 2026-08-03

### Added

- Initial backend-only architecture. `.gemini/settings.json` hooks + `.gemini/commands/armor/*.toml` custom slash commands (`/armor:list`, `/armor:add`, `/armor:template`, `/armor:help`). `POST /iap/enforce` for enforcement, `POST /iap/audit` for AfterTool records. Fail-closed when the plugin is not configured with an ArmorIQ API key.
