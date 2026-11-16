#!/usr/bin/env bash
# Builds the one release asset Gemini CLI installs from: the extension at the archive root with
# its production node_modules, because `gemini extensions install` never runs npm.
set -euo pipefail

out="${1:?usage: pack.sh <output.tar.gz>}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

git -C "$root" archive --format=tar HEAD \
  gemini-extension.json GEMINI.md package.json package-lock.json LICENSE README.md CHANGELOG.md \
  hooks commands scripts .gemini | COPYFILE_DISABLE=1 tar -x -C "$stage"
(cd "$stage" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --silent)

for required in gemini-extension.json hooks/hooks.json scripts/hook-router.mjs scripts/policy-mcp.mjs \
  node_modules/@modelcontextprotocol/sdk/package.json node_modules/zod/package.json; do
  [[ -e "$stage/$required" ]] || { echo "release archive is missing $required" >&2; exit 1; }
done

case "$out" in /*) ;; *) out="$PWD/$out" ;; esac
# macOS tar otherwise adds ._* AppleDouble files, which Gemini CLI tries to load as commands.
COPYFILE_DISABLE=1 tar -czf "$out" -C "$stage" .
echo "$out"
