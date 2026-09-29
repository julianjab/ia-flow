#!/usr/bin/env bash
# La memoria de los agentes entre corridas: el MCP oficial `server-memory` (un
# grafo de entidades y observaciones en un JSON) expuesto por HTTP con
# `supergateway`, para publicarlo con un túnel de cloudflared — el MCP lo llama
# Anthropic, no el runner, así que tiene que ser alcanzable desde internet.
#
#   MEMORY_MCP_TOKEN=<secreto> bun run memory-mcp
#   cloudflared tunnel --config ~/.cloudflared/<túnel>.yml run   # hostname → localhost:$PORT
#
# El server no autentica: el secreto va en el path (`/mcp/<token>`), y la URL
# completa (https://<hostname>/mcp/<token>) en MEMORY_MCP_URL del .env.
#
#   MEMORY_MCP_TOKEN   obligatorio: el path secreto
#   MEMORY_MCP_PORT    default 8931
#   MEMORY_FILE_PATH   default .state/memory.json (gitignoreado)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -z "${MEMORY_MCP_TOKEN:-}" ]]; then
  echo "falta MEMORY_MCP_TOKEN: el path secreto del MCP (queda público detrás del túnel)" >&2
  exit 1
fi
port="${MEMORY_MCP_PORT:-8931}"
export MEMORY_FILE_PATH="${MEMORY_FILE_PATH:-$here/.state/memory.json}"
mkdir -p "$(dirname "$MEMORY_FILE_PATH")"

echo "memory-mcp: http://localhost:$port/mcp/<token> → $MEMORY_FILE_PATH"
exec npx -y supergateway@4.0.0 \
  --stdio "npx -y @modelcontextprotocol/server-memory@2026.8.31" \
  --outputTransport streamableHttp \
  --streamableHttpPath "/mcp/$MEMORY_MCP_TOKEN" \
  --healthEndpoint /healthz \
  --port "$port"
