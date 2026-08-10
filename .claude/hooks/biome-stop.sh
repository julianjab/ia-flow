#!/usr/bin/env bash
# Stop hook: run full biome check --write once the turn ends.
# Silent on success; non-fatal on failure (exit 0) so we never block Claude.
set -euo pipefail

cd "${CLAUDE_PROJECT_DIR:-$(pwd)}"

if [ -x node_modules/.bin/biome ]; then
  node_modules/.bin/biome check --write --no-errors-on-unmatched . >/dev/null 2>&1 || true
fi

exit 0
