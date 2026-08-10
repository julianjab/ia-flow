#!/usr/bin/env bash
# PostToolUse hook: auto-format + lint-fix the file that was just Edit/Write'd.
# Silent on success; non-fatal on failure (exit 0) so we never block Claude.
set -euo pipefail

input="$(cat)"
path="$(printf '%s' "$input" | python3 -c 'import sys,json; d=json.load(sys.stdin); ti=d.get("tool_input",{}); print(ti.get("file_path") or ti.get("path") or "")' 2>/dev/null || true)"

[ -z "$path" ] && exit 0
[ ! -f "$path" ] && exit 0

case "$path" in
  *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.json)
    cd "${CLAUDE_PROJECT_DIR:-$(pwd)}"
    if [ -x node_modules/.bin/biome ]; then
      node_modules/.bin/biome format --write --no-errors-on-unmatched "$path" >/dev/null 2>&1 || true
    fi
    ;;
esac
exit 0
