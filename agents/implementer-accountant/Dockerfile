# ia-flow — engine headless (solo apps/server), pensado para correr con
# `podman build`/`podman run` (o docker, es un Dockerfile OCI estándar).
#
# Calcado de agents/functional-refiner/Dockerfile — ver los comentarios ahí
# para el razonamiento completo de por qué alcanza con 4 YAML en vez de 8.
# Diferencia con ese deploy: este roster (agents.implementer.yaml) escribe
# código real vía el MCP de GitHub (branch + commits + PR), no solo un PRD
# en el body del issue.
#
# Build context: la RAÍZ del repo, no esta carpeta (ver docker-compose.yml:
# build.context: ../..).

FROM oven/bun:1 AS deps
WORKDIR /app

COPY package.json bun.lockb* ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/ai-providers/package.json packages/ai-providers/package.json
COPY packages/issue-sources/package.json packages/issue-sources/package.json
COPY packages/agent-engine/package.json packages/agent-engine/package.json
COPY packages/tools/package.json packages/tools/package.json

RUN bun install

FROM oven/bun:1-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# WorkspaceManager (@ia-flow/agent-engine) shells out to `git clone` /
# `git worktree` / `git commit` for every anthropic-api run — needsWorkspace()
# gates on the provider id alone, not on the agent's tools. -slim doesn't
# ship git, so any real run would fail with ENOENT without this, aunque
# este agente en particular no lea el workspace clonado (escribe vía MCP).
#
# curl: lo usa entrypoint.sh para esperar a que el server responda. Este
# contenedor no abre ningún túnel — sólo expone un puerto (el del proxy de
# webhooks, ver scripts/webhook-proxy.ts) y el túnel público (cloudflared,
# ngrok, lo que sea) se corre AFUERA, en el host, apuntando a ese puerto
# mapeado — ver docker-compose.yml y README.md.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/package.json package.json
COPY packages/shared packages/shared
COPY packages/ai-providers packages/ai-providers
COPY packages/issue-sources packages/issue-sources
COPY packages/agent-engine packages/agent-engine
COPY packages/tools packages/tools
COPY apps/server apps/server
COPY scripts/webhook-proxy.ts scripts/webhook-proxy.ts

# Config fija de este deploy — editar cualquiera de estos YAML + reconstruir
# (o bind-mount en runtime, ver README.md) es la forma de cambiarlos. Los
# cuatro son read-only en modo yaml (Yaml*Repository tira si algo intenta
# escribir).
COPY agents/implementer-accountant/agents.implementer.yaml /app/config/agents.yaml
COPY agents/implementer-accountant/projects.yaml /app/config/projects.yaml
COPY agents/implementer-accountant/repos.yaml /app/config/repos.yaml
COPY agents/implementer-accountant/mcp-catalog.yaml /app/config/mcp-catalog.yaml

# Arranca el server + el proxy standalone de webhooks (scripts/webhook-proxy.ts,
# el único puerto pensado para exponerse a internet) e imprime el secret en el
# log del contenedor. Ver el archivo para el detalle completo.
COPY agents/implementer-accountant/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

ENV IA_FLOW_AGENT_REPO=yaml \
    IA_FLOW_AGENTS_FILE=/app/config/agents.yaml \
    IA_FLOW_PROJECT_REPO=yaml \
    IA_FLOW_PROJECTS_FILE=/app/config/projects.yaml \
    IA_FLOW_REPOS_REPO=yaml \
    IA_FLOW_REPOS_FILE=/app/config/repos.yaml \
    IA_FLOW_MCP_CATALOG_REPO=yaml \
    IA_FLOW_MCP_CATALOG_FILE=/app/config/mcp-catalog.yaml \
    IA_FLOW_CONFIG_DIR=/data \
    IA_FLOW_DB_PATH=/data/ia-flow.sqlite \
    PORT=3001 \
    IA_FLOW_PROXY_PORT=8787

# /data sigue existiendo para lo que no puede ser estático: tasks
# (filesystem-backed), execution log (SQLite, escribe en cada run), y las
# tablas `agents`/`projects`/`repos`/`mcp_catalog` que este roster no usa.
VOLUME ["/data"]
# 3001: API completa, sólo para debug directo (mapeada a 127.0.0.1 en el
# compose). 8787: el proxy de webhooks — el único puerto pensado para
# recibir tráfico público, vía un túnel corrido en el host.
EXPOSE 3001 8787

ENTRYPOINT ["/app/entrypoint.sh"]
