# Contributing to ArmorGemini

Thanks for wanting to help. ArmorGemini is the Gemini CLI plugin in the ArmorIQ family, alongside [ArmorClaude](https://github.com/armoriq/armorClaude), [ArmorCodex](https://github.com/armoriq/armorCodex), and [ArmorCopilot](https://github.com/armoriq/armorCopilot). It wires four Gemini CLI lifecycle hooks (`SessionStart`, `BeforeTool`, `AfterTool`, `SessionEnd`) into the ArmorIQ backend so every tool call is verified before it runs.

This doc covers how to file issues, get a working local setup, follow the code style we already use, and open a PR that stands a chance of being merged quickly.

If you are here to report a security vulnerability, do NOT open a public issue. Email license@armoriq.io directly.

## Ways to help

Roughly in order of what we most need:

- Reporting reproducible bugs (hook not firing, deny not blocking, session state getting corrupted).
- Improving documentation, both the in-repo `README.md` / `docs/` and the public docs at https://docs.armoriq.ai/armorgemini.
- Adding tests for edge cases: unknown tool names, malformed hook payloads, backend unreachable, expired tokens.
- Small correctness fixes and typos.
- Larger feature work, but please open an issue first so we can align on scope before you write code (see "Filing an issue" below).

## Filing an issue

Before starting work, open a GitHub issue on this repo. Even for small features, a short tracking issue up front means the change has a URL to reference from the PR, the release notes, and any cross-repo follow-ups.

Good bug reports include:

- The exact `gemini` CLI version (`gemini --version`) and Node version (`node --version`).
- The relevant slice of `~/.gemini/settings.json` (redact any keys that are not related).
- The exact prompt or command you ran.
- The full output, ideally with `ARMORGEMINI_DEBUG=true` set so the hook trace is visible on stderr.
- What you expected to happen, and what actually happened.

If the bug touches enforcement (a call that should have been denied went through, or vice-versa), please note whether an ArmorIQ API key was configured and which mode you were in (enforce vs. monitor). Do not paste the API key itself into an issue.

## Local development

You need Node 20 or later and `gemini` on your PATH. Then:

```bash
git clone https://github.com/armoriq/armorGemini
cd armorGemini
npm install
npm test
```

`npm test` runs the unit tests under `tests/`. They exercise the hook router, the engine's decision logic, and the small backend client with a stubbed transport. If they fail on a fresh checkout, that is a bug, please file an issue.

To test the hooks end to end against a real Gemini session, point `~/.gemini/settings.json` at your local checkout instead of the installed copy:

```json
{
  "hooks": {
    "SessionStart": [{ "matcher": "*", "hooks": [{ "name": "armorgemini-session-start", "type": "command", "command": "node /absolute/path/to/armorGemini/scripts/hook-router.mjs session-start" }] }],
    "BeforeTool":   [{ "matcher": "*", "hooks": [{ "name": "armorgemini-before-tool",   "type": "command", "command": "node /absolute/path/to/armorGemini/scripts/hook-router.mjs before-tool"   }] }],
    "AfterTool":    [{ "matcher": "*", "hooks": [{ "name": "armorgemini-after-tool",    "type": "command", "command": "node /absolute/path/to/armorGemini/scripts/hook-router.mjs after-tool"    }] }],
    "SessionEnd":   [{ "matcher": "*", "hooks": [{ "name": "armorgemini-session-end",   "type": "command", "command": "node /absolute/path/to/armorGemini/scripts/hook-router.mjs session-end"   }] }]
  }
}
```

Set `ARMORGEMINI_DEBUG=true` to see the hook trace on stderr as you interact with the CLI.

For a staging backend, `armoriq login --product armorgemini` writes the API key to `~/.armoriq/credentials.json`. The engine picks that up automatically.

## Code style

- The plugin is plain ESM JavaScript (`.mjs`), no TypeScript, no build step. Keep it that way, so the file the installer copies is the file that runs.
- Match the existing formatting: two-space indent, double quotes for strings, semicolons.
- Prefer small pure functions in `scripts/lib/` over adding state to the hook router.
- No new heavy dependencies. The runtime already avoids anything outside Node's standard library plus `@armoriq/sdk`; keep that boundary.
- Errors during a hook must not crash the hook. In enforce mode, fail closed (return `decision: "deny"`); in monitor mode, log and continue. There are tests that assert this, do not regress it.
- No AI-attribution trailers in commit messages or PR bodies. Write in the normal voice of the repo.

## Tests

If you change enforcement behavior, add or update a test in `tests/`. The router, engine, and backend client are all stubbed at the transport boundary so tests can run offline. `npm test` must pass before you open a PR; PRs with failing tests get bounced immediately.

## Opening a pull request

1. Fork the repo and create a branch off `main`. Name it something scannable, e.g. `fix/beforetool-null-payload` or `feat/armor-remove-command`.
2. Reference the issue in the PR description (`Fixes #123` for bug fixes and workarounds, `Closes #123` for features, `Refs #123` for related but non-closing).
3. Keep PRs focused. One logical change per PR. Unrelated cleanup goes in a separate PR.
4. Include:
   - A one-paragraph summary of what changed and why (the "why" is the important part).
   - The exact command sequence you used to verify it locally.
   - Any behavioral changes users would notice (config flags, error messages, exit codes).
5. Do not squash or force-push mid-review unless a reviewer asks. Add new commits; we squash on merge.

## What we will not merge

- Changes that add telemetry, analytics, or "phone home" behavior beyond the existing ArmorIQ audit path.
- Changes that broaden the plugin's implicit trust surface (e.g. running the hook payload through a shell without escaping).
- Silent behavior changes that are not covered by a test.
- Reformatting-only PRs across large parts of the codebase.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
