#!/usr/bin/env node
// ArmorGemini policy MCP server.
//
// Runs as a stdio MCP server so Gemini CLI can call our tools directly. In
// v0.3 there is one tool that matters: register_intent_plan. When onBeforeAgent
// injects the "declare your plan first" directive into the model's context,
// the model is expected to call this tool with a JSON plan before it touches
// any other tool. We validate the shape, store the plan on disk keyed on
// session_id, and return a receipt. Subsequent BeforeTool hooks read that
// plan and deny anything not in it.
//
// Gemini discovers this server via the mcpServers field in
// gemini-extension.json. There is no separate install step: the extension
// manifest, the settings.json hook wiring, and this MCP server all ship in
// the same repo and are loaded together.
//
// Design notes:
//  - stdio transport, not HTTP. Gemini launches this as a child process; no
//    ports open.
//  - Uses @modelcontextprotocol/sdk (same SDK ArmorClaude's MCP server uses),
//    which handles the JSON-RPC framing so we only write the tool logic.
//  - Session id: passed as a tool argument by the model. Reason: MCP doesn't
//    surface the CLI's session id in a standard way, and the model can read
//    it from the directive injected by onBeforeAgent (the directive
//    interpolates ${session_id} into the instructions). The stored plan file
//    path is deterministic from that id.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { loadConfig } from "./lib/config.mjs";
import { validateIntentPlan, planToolNames } from "./lib/intent-schema.mjs";
import { savePlan, loadPlan, clearPlan } from "./lib/planner.mjs";

const config = loadConfig();

// Small stderr logger. Every MCP server child writes to stderr for
// diagnostics; stdout is reserved for MCP JSON-RPC frames. Never write to
// stdout from anywhere except the SDK.
function log(msg) {
  process.stderr.write(`[armorgemini-mcp] ${msg}\n`);
}

const server = new McpServer(
  {
    name: "armorgemini-policy",
    version: "0.3.0"
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: register_intent_plan
// ---------------------------------------------------------------------------
// The model calls this at the start of a turn with the plan it is about to
// execute. The tool stores the plan for the current session, keyed on the
// session_id the model reads from the directive injected by onBeforeAgent.
//
// On success it returns a receipt + the tool names it will let through so
// the model can double-check its plan was captured correctly.
//
// On failure (bad shape, empty steps, missing session_id) it returns an
// error text that the model can use to correct itself and retry. This is
// intentional: the model's next turn should re-emit the plan in the right
// shape, not silently proceed.

server.registerTool(
  "register_intent_plan",
  {
    title: "Register an intent plan for the current session",
    description:
      "Declare the tools you intend to call BEFORE using any other tool. " +
      "ArmorGemini enforces every tool call at BeforeTool time against this " +
      "plan; drift (a tool not listed here) is denied. Pass the session_id " +
      "that was included in the directive you were shown at the start of " +
      "this turn.",
    inputSchema: {
      session_id: z
        .string()
        .min(1)
        .describe("The Gemini CLI session id, as included in the ArmorGemini directive at the start of this turn."),
      goal: z
        .string()
        .min(1)
        .describe("One-line summary of what this plan accomplishes."),
      steps: z
        .array(
          z.object({
            action: z
              .string()
              .min(1)
              .describe("Gemini CLI tool name, e.g. read_file, write_file, run_shell_command, google_web_search, web_fetch, glob, list_directory, search_file_content, edit."),
            description: z.string().optional().describe("Why this step is needed."),
            metadata: z.record(z.unknown()).optional().describe("Expected tool parameters (optional).")
          })
        )
        .min(1)
        .describe("Ordered list of the tool calls you plan to make this turn.")
    }
  },
  async ({ session_id, goal, steps }) => {
    const result = validateIntentPlan({ goal, steps });
    if (!result.ok) {
      log(`register_intent_plan REJECT session=${session_id} reason="${result.error}"`);
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `ArmorGemini rejected the plan: ${result.error}. Re-emit register_intent_plan with a corrected plan; do not call any other tool until it is accepted.`
          }
        ]
      };
    }

    const record = savePlan(config.dataDir, session_id, result.plan);
    const tools = planToolNames(result.plan);
    log(`register_intent_plan OK session=${session_id} goal="${result.plan.goal}" tools=[${tools.join(",")}]`);

    return {
      content: [
        {
          type: "text",
          text:
            `Plan registered for session ${record.session_id}. ` +
            `Tools allowed this turn: ${tools.join(", ")}. ` +
            `Any tool not in this list will be denied at BeforeTool.`
        }
      ]
    };
  }
);

// ---------------------------------------------------------------------------
// Tool: reset_intent_plan
// ---------------------------------------------------------------------------
// Explicit way for the model (or a future /armor:replan command) to clear a
// stale plan and force a re-registration. Useful when the goal genuinely
// changes mid-session and the old plan would deny the new work.

server.registerTool(
  "reset_intent_plan",
  {
    title: "Clear the plan for the current session",
    description:
      "Discard the currently registered plan so a fresh one can be submitted. " +
      "Every subsequent tool call will be denied until you call " +
      "register_intent_plan again. Pass the session_id from the ArmorGemini directive.",
    inputSchema: {
      session_id: z
        .string()
        .min(1)
        .describe("The Gemini CLI session id.")
    }
  },
  async ({ session_id }) => {
    clearPlan(config.dataDir, session_id);
    log(`reset_intent_plan session=${session_id}`);
    return {
      content: [
        {
          type: "text",
          text: `Plan cleared for session ${session_id}. Call register_intent_plan before any further tool.`
        }
      ]
    };
  }
);

// ---------------------------------------------------------------------------
// Tool: get_intent_plan (read-only introspection, useful for debug/demo)
// ---------------------------------------------------------------------------

server.registerTool(
  "get_intent_plan",
  {
    title: "Read the current registered plan",
    description:
      "Return the plan currently registered for a session (or null if none). Purely informational.",
    inputSchema: {
      session_id: z.string().min(1).describe("The Gemini CLI session id.")
    }
  },
  async ({ session_id }) => {
    const plan = loadPlan(config.dataDir, session_id);
    if (!plan) {
      return {
        content: [
          {
            type: "text",
            text: `No plan registered for session ${session_id}. Call register_intent_plan before any tool.`
          }
        ]
      };
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(plan, null, 2)
        }
      ]
    };
  }
);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
log(`armorgemini-policy MCP server up. dataDir=${config.dataDir}`);
