#!/usr/bin/env bash
# Carga y valida una config de ia-flow (runner.yaml + projects/) con el runner, sin servir.
#   validate-config.sh [runner.yaml | carpeta]
# Runner a usar, en orden: $IA_FLOW_REPO (checkout de ia-flow) → $IA_FLOW_RUNNER_BUNDLE →
# ~/.local/share/ia-flow/ia-flow-runner.js (el bundle de la release).
set -euo pipefail

config="${1:-}"
if [[ -z "$config" ]]; then
  if [[ -f runner.yaml ]]; then config="runner.yaml"
  else
    found="$(find . -maxdepth 5 -name runner.yaml -not -path '*/node_modules/*' | head -5)"
    count="$(printf '%s\n' "$found" | grep -c . || true)"
    if [[ "$count" == "1" ]]; then config="$found"
    else
      echo "No sé cuál config validar. Pasá la ruta. Candidatas:" >&2
      printf '%s\n' "$found" >&2
      exit 2
    fi
  fi
fi

if [[ -n "${IA_FLOW_REPO:-}" && -d "$IA_FLOW_REPO/apps/runner-v2" ]]; then
  exec bun run --cwd "$IA_FLOW_REPO/apps/runner-v2" start --config "$(cd "$(dirname "$config")" && pwd)/$(basename "$config")"
fi

bundle="${IA_FLOW_RUNNER_BUNDLE:-$HOME/.local/share/ia-flow/ia-flow-runner.js}"
if [[ -f "$bundle" ]]; then
  exec bun "$bundle" --config "$config"
fi

cat >&2 <<MSG
No encuentro un runner de ia-flow para validar. Una de dos:
  export IA_FLOW_REPO=<ruta al checkout de ia-flow>
  export IA_FLOW_RUNNER_BUNDLE=<ruta a ia-flow-runner.js>   (de la release: bun run release:package)
MSG
exit 3
