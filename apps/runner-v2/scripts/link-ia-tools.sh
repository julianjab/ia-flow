#!/usr/bin/env bash
# Registra con `bun link` los paquetes de ia-tools que runner-v2 consume como
# `link:@ia-tools/<paquete>` (todavía no se publican). Correr una vez por máquina,
# y de nuevo si se agrega un paquete; después `bun install`.
#
#   IA_TOOLS_DIR=~/code/ia-tools bun run link:ia-tools
#
# Default: ia-tools clonado al lado de ia-flow. Los paquetes tienen que estar
# instalados y compilados allá (`pnpm install && pnpm build` en ia-tools).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ia_tools="${IA_TOOLS_DIR:-$(cd "$here/../../../.." && pwd)/ia-tools}"

if [[ ! -d "$ia_tools/packages/agent-engine/core" ]]; then
  echo "No encuentro ia-tools en $ia_tools — pasalo con IA_TOOLS_DIR=<ruta>" >&2
  exit 1
fi

packages=(
  agent-engine/core
  agent-engine/sqlite
  agent-engine/yaml
  provider-anthropic
  telemetry
  github/api
  github/auth
  github/tools
  github/webhook
  local/workspace
)

for package in "${packages[@]}"; do
  dir="$ia_tools/packages/$package"
  if [[ ! -f "$dir/dist/index.js" ]]; then
    echo "$dir no está compilado — corré \`pnpm build\` en ia-tools" >&2
    exit 1
  fi
  (cd "$dir" && bun link >/dev/null)
  echo "linked $(node -p "require('$dir/package.json').name")"
done
