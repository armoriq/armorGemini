#!/usr/bin/env node
// Prints the release version, or exits non-zero when the copies disagree. Gemini CLI compares the
// manifest version and the release tag, so a drifted copy would make every update check wrong.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (file) => JSON.parse(readFileSync(path.join(root, file), "utf8"));

const pkg = read("package.json");
const lock = read("package-lock.json");
const copies = {
  "package.json": pkg.version,
  "gemini-extension.json": read("gemini-extension.json").version,
  "package-lock.json": lock.version,
  'package-lock.json packages[""]': lock.packages?.[""]?.version,
};

const versions = new Set(Object.values(copies));
if (versions.size !== 1 || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(pkg.version)) {
  for (const [file, version] of Object.entries(copies)) console.error(`${file}: ${version}`);
  console.error("version copies disagree or are not semver");
  process.exit(1);
}
console.log(pkg.version);
