import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fixture(overrides) {
  const dir = mkdtempSync(path.join(tmpdir(), "armorgemini-version-"));
  mkdirSync(path.join(dir, "scripts", "release"), { recursive: true });
  cpSync(path.join(repo, "scripts", "release", "check-version.mjs"), path.join(dir, "scripts", "release", "check-version.mjs"));
  for (const file of ["package.json", "package-lock.json", "gemini-extension.json"]) {
    const parsed = JSON.parse(readFileSync(path.join(repo, file), "utf8"));
    writeFileSync(path.join(dir, file), JSON.stringify(overrides[file]?.(parsed) ?? parsed));
  }
  return spawnSync(process.execPath, [path.join(dir, "scripts", "release", "check-version.mjs")], { encoding: "utf8" });
}

test("check-version prints the version when every copy agrees", () => {
  const result = fixture({});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8")).version);
});

test("check-version fails when the extension manifest drifts from package.json", () => {
  const result = fixture({ "gemini-extension.json": (m) => ({ ...m, version: "9.9.9" }) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /gemini-extension.json: 9\.9\.9/);
});

test("check-version fails when the lockfile drifts", () => {
  const result = fixture({ "package-lock.json": (l) => ({ ...l, version: "0.0.1" }) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /package-lock.json: 0\.0\.1/);
});
