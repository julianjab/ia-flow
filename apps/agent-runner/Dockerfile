# ia-flow — engine headless genérico (solo apps/server, sin la SPA web).
# Pensado para `podman build`/`podman run` (o docker, es un Dockerfile OCI
# estándar). Hermano de apps/ai-provider-gateway: así como ese es "la app de
# provider" que cualquiera levanta y registra contra el server principal,
# este es "la app de runner" — corre un roster de agentes completo contra un
# proyecto, sin conocer de antemano cuál. La config (4 YAML: agents/projects/
# repos/mcp-catalog) NUNCA se copia acá adentro — entra 100% por bind-mount
# en runtime (ver docker-compose.example.yml), así que la MISMA imagen sirve
# para cualquier roster/proyecto sin rebuild.
#
# Build context: la RAÍZ del repo, no esta carpeta — necesita el workspace de
# Bun completo (ver docker-compose.example.yml: build.context: ../..).
#
# Soporta los dos modos de daemon (IA_FLOW_DAEMON_MODE, ver
# apps/server/CLAUDE.md) con el MISMO entrypoint — webhook arranca además el
# proxy standalone de webhooks (scripts/webhook-proxy.ts) y expone su puerto;
# polling corre solo el server. Ver entrypoint.sh.

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
COPY packages/workspace/package.json packages/workspace/package.json

RUN bun install

FROM oven/bun:1-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# WorkspaceManager (@ia-flow/agent-engine) shells out a `git clone`/
# `git worktree`/`git commit` en cada run de anthropic-api — needsWorkspace()
# gatea solo por el id del provider, no por las tools del agente. -slim no
# trae git, así que cualquier run real fallaría con ENOENT sin esto, aunque
# el roster que termines corriendo escriba 100% vía MCP (sin checkout local).
#
# curl: lo usa entrypoint.sh para esperar a que el server responda antes de
# imprimir el banner del webhook.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/package.json package.json
COPY packages/shared packages/shared
COPY packages/ai-providers packages/ai-providers
COPY packages/issue-sources packages/issue-sources
COPY packages/agent-engine packages/agent-engine
COPY packages/tools packages/tools
COPY packages/workspace packages/workspace
COPY apps/server apps/server
COPY scripts/webhook-proxy.ts scripts/webhook-proxy.ts

COPY apps/agent-runner/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Los 4 archivos abajo NO existen en la imagen — /app/config queda vacío a
# propósito. Quien corra el container bind-montea sus propios 4 YAML ahí (ver
# docker-compose.example.yml); Yaml*Repository tira si algo intenta escribir,
# así que quedan read-only por diseño.
RUN mkdir -p /app/config
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
# tablas `agents`/`projects`/`repos`/`mcp_catalog` que un roster en modo YAML
# no usa (quedan vacías — getDb() no es condicional). El resto (statuses,
# system_prompts, global_settings, prompts) sigue en SQLite activo por
# default y se puede leer/editar normal si algún día hace falta.
VOLUME ["/data"]

# 3001: API completa, sin auth propia — pensada para debug directo (mapeala
# solo a 127.0.0.1). 8787: el proxy de webhooks (solo relevante en modo
# webhook) — el único puerto pensado para recibir tráfico público, vía un
# túnel corrido en el host.
EXPOSE 3001 8787

ENTRYPOINT ["/app/entrypoint.sh"]
