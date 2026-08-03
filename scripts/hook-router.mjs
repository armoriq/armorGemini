#!/usr/bin/env node
// ArmorGemini hook router.
// Reads the Gemini CLI hook payload from stdin, dispatches to the right handler
// (before-tool / after-tool / session-start / session-end), and prints the
// Gemini-shaped decision JSON to stdout. All diagnostics go to stderr.

import { readStdin, writeDecision, writeError } from "./lib/hook-io.mjs";
import { onBeforeTool } from "./lib/engine.mjs";
import { onAfterTool, onSessionStart, onSessionEnd } from "./lib/engine.mjs";

const event = process.argv[2];

if (!event) {
  writeError("hook-router requires an event argument: before-tool | after-tool | session-start | session-end");
  process.exit(2);
}

try {
  const payload = await readStdin();

  switch (event) {
    case "before-tool":
      writeDecision(await onBeforeTool(payload));
      break;
    case "after-tool":
      writeDecision(await onAfterTool(payload));
      break;
    case "session-start":
      writeDecision(await onSessionStart(payload));
      break;
    case "session-end":
      writeDecision(await onSessionEnd(payload));
      break;
    default:
      writeError(`unknown event: ${event}`);
      process.exit(2);
  }
} catch (err) {
  writeError(`ArmorGemini hook error: ${err?.stack || err?.message || String(err)}`);
  writeDecision({ decision: "allow" });
}
