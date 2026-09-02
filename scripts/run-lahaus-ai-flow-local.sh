#!/usr/bin/env bash
# Corre el runner headless LOCALMENTE contra el roster real de
# `ai-development-flow` (la-haus/claw-agents, agents/ai-development-flow/config/),
# con el mismo comportamiento que el pod de producción — ver:
#   - la-haus/eks: ss/resources/services/claw-agents/agents/engineer/ai-development-flow/
#     (deployment.yml, variables.yml, sec-ai-development-flow.enc.yml)
#   - la-haus/claw-agents: agents/ai-development-flow/{Dockerfile,config/runner.yaml}
#
# Lo que el pod fija por env y ACÁ hay que setear a mano (secretos, o rutas
# que en el pod son del volumen y acá no existen):
#
#   CLAUDE_CODE_OAUTH_TOKEN            secret del pod (o ANTHROPIC_API_KEY)
#   IA_FLOW_GITHUB_APP_PRIVATE_KEY_PATH  en el pod es /secrets/github-app/private-key.pem
#                                       (Secret volume). Localmente no existe ese
#                                       path — apuntá a tu copia del PEM de la
#                                       GitHub App "ai-lh-developer" (appId 4752324).
#                                       El runner.yaml trae ese path hardcodeado,
#                                       pero `applyRunnerEnv` NO pisa una env var
#                                       que ya esté seteada (config.ts:`put`), así
#                                       que exportarla ANTES de correr esto gana.
#   IA_FLOW_WEBHOOK_SECRET             opcional acá: sin ingress no llega ningún
#                                       delivery real; déjalo vacío y el runner
#                                       genera uno propio en IA_FLOW_CONFIG_DIR.
#   IA_FLOW_API_TOKEN                  opcional: sólo hace falta si vas a pegarle
#                                       a /api/* (settings.api: full en el YAML).
#
# Lo que EL YAML ya trae y no hay que duplicar (mode: github-app, appId,
# installationId, daemonMode, logLevel, api, remoteProviders, workspace): los
# vuelca `applyRunnerEnv` — ver la tabla SETTINGS_ENV/GITHUB_ENV en
# apps/server/src/runner/config.ts.
#
# Lo que NO hace falta acá (son del contenedor, no del proceso):
#   AWS_DEFAULT_REGION, HOME, LOG_PLAIN, UV_CACHE_DIR, UV_LINK_MODE — nada de
#   esto lo lee ia-flow; son del pod/imagen (región no usada por el engine,
#   HOME es cache de Bun, LOG_PLAIN evita el worker de pino que en el bundle
#   sin node_modules muere — localmente con node_modules presente no aplica).
#
# GITHUB_TOKEN: NO hace falta. El runner.yaml fuerza `github.mode: github-app`
# (explícito, no `auto`), así que la identidad de GitHub sale del PEM +
# appId/installationId, resuelta por uso — nunca de esa env var.

set -euo pipefail

CLAW_AGENTS_CONFIG="${CLAW_AGENTS_CONFIG:-$HOME/development/lahaus/agents/claw-agents/agents/ai-development-flow/config/runner.yaml}"

if [[ ! -f "$CLAW_AGENTS_CONFIG" ]]; then
  echo "No encuentro runner.yaml en: $CLAW_AGENTS_CONFIG" >&2
  echo "Pasá CLAW_AGENTS_CONFIG=/otra/ruta/runner.yaml si tu checkout está en otro lado." >&2
  exit 1
fi

: "${CLAUDE_CODE_OAUTH_TOKEN:?Falta CLAUDE_CODE_OAUTH_TOKEN (o exportá ANTHROPIC_API_KEY y comentá este check)}"
: "${IA_FLOW_GITHUB_APP_PRIVATE_KEY_PATH:?Falta IA_FLOW_GITHUB_APP_PRIVATE_KEY_PATH — apuntá al PEM local de la GitHub App ai-lh-developer}"

if [[ ! -f "$IA_FLOW_GITHUB_APP_PRIVATE_KEY_PATH" ]]; then
  echo "IA_FLOW_GITHUB_APP_PRIVATE_KEY_PATH no existe: $IA_FLOW_GITHUB_APP_PRIVATE_KEY_PATH" >&2
  exit 1
fi

# Aislado del dev normal (que usa ~/.config/ia-flow) para no mezclar la SQLite
# ni los clones de este roster con tu instancia de `bun run dev`.
export IA_FLOW_CONFIG_DIR="${IA_FLOW_CONFIG_DIR:-$HOME/.config/ia-flow-lahaus-ai-flow}"
export IA_FLOW_DB_PATH="${IA_FLOW_DB_PATH:-$IA_FLOW_CONFIG_DIR/ia-flow.sqlite}"
mkdir -p "$IA_FLOW_CONFIG_DIR"

echo "IA_FLOW_CONFIG_DIR=$IA_FLOW_CONFIG_DIR"
echo "runner.yaml=$CLAW_AGENTS_CONFIG"

cd "$(dirname "${BASH_SOURCE[0]}")/.."
exec bun run apps/server/src/entry/runner.ts "$CLAW_AGENTS_CONFIG"
