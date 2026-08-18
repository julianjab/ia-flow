# ia-flow — engine headless (solo apps/server), pensado para correr con
# `podman build`/`podman run` (o docker, es un Dockerfile OCI estándar).
#
# Todos los packages del workspace son source-only (ver packages/*/package.json
# "build": "echo ... is source-only") — Bun ejecuta TypeScript directo, así que
# no hay paso de compilación: instalar deps alcanza.
#
# El roster de agentes de este contenedor lo decide IA_FLOW_AGENT_REPO=yaml +
# apps/server/docker/agents.refiner.yaml (YamlAgentRepository, read-only) en
# vez de la tabla `agents` de SQLite — ver apps/server/src/infrastructure/yaml/.

FROM oven/bun:1 AS deps
WORKDIR /app

# Copiar solo los manifests primero: capa cacheable mientras no cambien deps.
# bun resuelve el workspace completo (root package.json define "apps/*" y
# "packages/*"), así que cada package.json del monorepo tiene que estar
# presente aunque este engine solo corra apps/server.
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

COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/package.json package.json
COPY packages/shared packages/shared
COPY packages/ai-providers packages/ai-providers
COPY packages/issue-sources packages/issue-sources
COPY packages/agent-engine packages/agent-engine
COPY packages/tools packages/tools
COPY apps/server apps/server

# Roster fijo de un solo agente (refiner). Editar este YAML + reconstruir (o
# montarlo por bind-mount) es la única forma de cambiar el roster en modo yaml.
COPY apps/server/docker/agents.refiner.yaml /app/config/agents.yaml

ENV IA_FLOW_AGENT_REPO=yaml \
    IA_FLOW_AGENTS_FILE=/app/config/agents.yaml \
    IA_FLOW_CONFIG_DIR=/data \
    IA_FLOW_DB_PATH=/data/ia-flow.sqlite \
    PORT=3001

# El resto de la app (tasks, projects, statuses, execution log) sigue en
# SQLite bajo /data — solo el roster de agentes sale de la DB.
VOLUME ["/data"]
EXPOSE 3001

WORKDIR /app/apps/server
CMD ["bun", "run", "prod"]
