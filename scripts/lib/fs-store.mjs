// Filesystem storage for policy, session state, and audit logs.
// Data dir precedence:
//   1. $ARMORGEMINI_DATA_DIR
//   2. ~/.armoriq/armorgemini

import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export function resolveDataDir() {
  return process.env.ARMORGEMINI_DATA_DIR || path.join(homedir(), ".armoriq", "armorgemini");
}

async function ensureDir(dir) {
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
}

export async function readJsonFile(name) {
  const file = path.join(resolveDataDir(), name);
  if (!existsSync(file)) return null;
  const text = await readFile(file, "utf8");
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function writeJsonFile(name, obj) {
  const dir = resolveDataDir();
  await ensureDir(dir);
  const file = path.join(dir, name);
  await writeFile(file, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

export async function appendAuditLine(obj) {
  const dir = path.join(resolveDataDir(), "audit");
  await ensureDir(dir);
  const day = new Date().toISOString().slice(0, 10);
  const file = path.join(dir, `${day}.jsonl`);
  await appendFile(file, JSON.stringify(obj) + "\n", "utf8");
  return file;
}
