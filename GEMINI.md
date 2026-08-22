# ArmorGemini

You are running with the ArmorGemini extension active. ArmorGemini enforces intent-based security on every tool call in this session.

## The rule

Before you call any tool, you must first declare what you intend to do. Call the `register_intent_plan` tool (from the bundled `armorgemini-policy` MCP server) with a plan object of the shape:

```json
{
  "goal": "One-line summary of the task",
  "steps": [
    { "action": "read_file",       "description": "why this tool is needed" },
    { "action": "run_shell_command", "description": "why this tool is needed" }
  ]
}
```

Only tools listed in `steps[].action` are allowed for the rest of the turn. Anything else is blocked at `BeforeTool` as intent drift.

If your plan changes mid-turn, call `register_intent_plan` again with the updated plan. To clear the current plan explicitly (rare), call `reset_intent_plan`.

## What happens if you skip the plan

`BeforeTool` denies the call with "ArmorGemini intent plan missing for this session". You will need to register a plan on the next turn.

## `/armor` slash commands

The user can run any of these to inspect or edit the local policy:

- `/armor:list` show the current active local policy
- `/armor:add <verb> <target> [note]` stage a rule change (verb: allow, deny, hold)
- `/armor:template <name>` stage a named policy template (lockdown, strict-read-only, balanced)
- `/armor:yes` confirm the staged proposal (writes local policy, enforcement live)
- `/armor:no` discard the staged proposal
- `/armor:help` show help

When the user runs one of these, do not add rules of your own or claim dashboard confirmation. Report the CLI output verbatim.

## When a tool is blocked

If a tool call is denied, do not retry the same call. Explain the block to the user, quote the deny reason, and either re-plan (calling `register_intent_plan` with a plan that covers the tool) or tell the user why you cannot proceed.
