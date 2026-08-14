// Per-session plan storage for ArmorGemini.
//
// A plan lives in ${dataDir}/plans/<session_id>.json. The MCP server writes
// it via register_intent_plan; the engine reads it at BeforeTool and
// BeforeToolSelection to enforce drift. Simple file-based so there is no
// daemon or in-memory coupling between the hook processes and the MCP
// server process.
//
// File format:
//   {
//     "session_id": "...",
//     "registered_at": "2026-08-14T...",
//     "goal": "...",
//     "steps": [{ "action": "read_file", "description": "...", "metadata": {} }, ...]
//   }

import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";

function safeSessionId(sessionId) {
  // Whitelist alnum + dash + underscore. Anything else becomes '_'. Keeps
  // the filename portable across every OS Gemini CLI ships on, and blocks
  // path traversal on a malicious session_id from the hook payload.
  return String(sessionId || "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128) || "unknown";
}

function planFilePath(dataDir, sessionId) {
  return path.join(dataDir, "plans", `${safeSessionId(sessionId)}.json`);
}

/**
 * Store a validated plan for the given session id. Overwrites any existing
 * plan (later plans supersede earlier ones within a session; the last one
 * the model produced is authoritative).
 */
export function savePlan(dataDir, sessionId, plan) {
  const dir = path.join(dataDir, "plans");
  mkdirSync(dir, { recursive: true });
  const record = {
    session_id: safeSessionId(sessionId),
    registered_at: new Date().toISOString(),
    goal: plan.goal,
    steps: plan.steps
  };
  writeFileSync(planFilePath(dataDir, sessionId), JSON.stringify(record, null, 2) + "\n");
  return record;
}

/**
 * Read the current plan for a session. Returns null if there is none, or
 * if the file exists but is corrupt (fail-closed at the caller's discretion).
 */
export function loadPlan(dataDir, sessionId) {
  const file = planFilePath(dataDir, sessionId);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Explicit forget — used by SessionEnd to keep the plan directory bounded
 * and by /armor:reset flows in the future.
 */
export function clearPlan(dataDir, sessionId) {
  const file = planFilePath(dataDir, sessionId);
  if (existsSync(file)) {
    try {
      unlinkSync(file);
    } catch {
      // best effort
    }
  }
}

/**
 * True iff a plan is currently registered for this session.
 */
export function hasPlan(dataDir, sessionId) {
  return existsSync(planFilePath(dataDir, sessionId));
}

/**
 * How old (in seconds) is the currently-stored plan? Callers use this to
 * expire stale plans without having to encode a TTL into the file itself.
 * Returns Number.POSITIVE_INFINITY when there is no plan.
 */
export function planAgeSeconds(dataDir, sessionId) {
  const file = planFilePath(dataDir, sessionId);
  if (!existsSync(file)) return Number.POSITIVE_INFINITY;
  try {
    const st = statSync(file);
    return Math.max(0, (Date.now() - st.mtimeMs) / 1000);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
