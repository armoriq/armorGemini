// Local staging store for /armor:add and /armor:template.
//
// Matches ArmorClaude's convention: a policy change is first STAGED to a
// file inside dataDir, previewed to the user as YAML, and only pushed to
// the ArmorIQ backend when the user runs /armor:yes. /armor:no discards.
//
// One pending proposal per workspace at a time (armorClaude does the same).
// The file lives at ${dataDir}/policy-pending.json.

import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const PROPOSAL_TTL_MS = 30 * 60 * 1000; // 30 minutes

function pendingPath(dataDir) {
  return path.join(dataDir, "policy-pending.json");
}

/**
 * Write a staged proposal. Overwrites whatever was staged before; that
 * matches the ArmorClaude UX where re-running /armor:add supersedes any
 * unconfirmed prior stage.
 */
export function stagePending(dataDir, { policy, reason, source }) {
  mkdirSync(dataDir, { recursive: true });
  const record = {
    proposalId: `prop_${randomUUID().slice(0, 8)}`,
    stagedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + PROPOSAL_TTL_MS).toISOString(),
    reason: reason || "Staged via ArmorGemini /armor",
    source: source || "cli",
    policy
  };
  writeFileSync(pendingPath(dataDir), JSON.stringify(record, null, 2) + "\n");
  return record;
}

/**
 * Read the current staged proposal, or null if nothing is staged / the
 * file is corrupt. Returns { record, expired } — expired=true when the
 * proposal is past its TTL and the caller should treat it as "nothing
 * staged" and clear the file.
 */
export function readPending(dataDir) {
  const p = pendingPath(dataDir);
  if (!existsSync(p)) return { record: null, expired: false };
  try {
    const record = JSON.parse(readFileSync(p, "utf-8"));
    const expired = record.expiresAt ? Date.now() > Date.parse(record.expiresAt) : false;
    return { record, expired };
  } catch {
    return { record: null, expired: false };
  }
}

/**
 * Remove the staged proposal file. Used by /armor:yes after successful
 * confirmation and by /armor:no.
 */
export function clearPending(dataDir) {
  const p = pendingPath(dataDir);
  if (existsSync(p)) {
    try {
      unlinkSync(p);
    } catch {
      // best effort
    }
  }
}

export function hasPending(dataDir) {
  return existsSync(pendingPath(dataDir));
}
