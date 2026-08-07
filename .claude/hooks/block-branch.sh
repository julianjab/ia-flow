#!/usr/bin/env bash
# Blocks feature-branch creation. ia-flow se trabaja en main.
# Reads tool input from stdin (Claude Code hook contract).
set -euo pipefail

input="$(cat)"
cmd="$(printf '%s' "$input" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("tool_input",{}).get("command",""))' 2>/dev/null || true)"

case "$cmd" in
  *"git checkout -b "*|*"git switch -c "*|*"git branch "*)
    echo "🚫 ia-flow se trabaja en main — no crear feature branches." >&2
    exit 2
    ;;
esac
exit 0
