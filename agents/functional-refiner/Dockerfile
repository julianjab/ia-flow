# ia-flow — engine headless (solo apps/server), pensado para correr con
# `podman build`/`podman run` (o docker, es un Dockerfile OCI estándar).
#
# Build context: la RAÍZ del repo, no esta carpeta — el Dockerfile necesita
# todo el workspace de Bun (ver docker-compose.yml: build.context: ../..).
#
# Todos los packages del workspace son source-only (ver packages/*/package.json
# "build": "echo ... is source-only") — Bun ejecuta TypeScript directo, así que
# no hay paso de compilación: instalar deps alcanza.
#
# Solo 4 de los 8 repos dual-source salen de YAML acá — los que este roster
# realmente necesita: agentes, proyecto, repo, y catálogo MCP (este roster
# refina vía el MCP de GitHub — mcpCatalogIds: [github-mcp] — en vez de
# fs_read/fs_list/fs_grep, ver agents.refiner.github-issues.yaml y
# mcp-catalog.yaml). Cada uno vía su env var puntual (IA_FLOW_AGENT_REPO /
# IA_FLOW_PROJECT_REPO / IA_FLOW_REPOS_REPO / IA_FLOW_MCP_CATALOG_REPO), no
# el switch global IA_FLOW_REPO_SOURCE — eso encendería los 8 de una y
# exigiría un archivo para cada uno aunque este roster no los use (statuses,
# system prompts, settings, prompts). Esos 4 quedan en SQLite por default,
# sin tocar (la tabla existe pero nadie la lee ni la escribe desde este
# roster) — ver apps/server/src/infrastructure/db/index.ts
# (`pickRepo`/`resolveRepoSource`) para el mecanismo de selección, y
# README.md ("Qué YAML hace falta realmente") para el razonamiento completo
# de por qué estos 4 alcanzan. `statuses` en particular ya no hace falta
# para ningún roster: el engine dejó de filtrar el scan por esa tabla (ver
# TaskDispatcher.dispatch/selectAgent en packages/agent-engine).
#
# Lo que sigue en SQLite bajo /data además de eso: tasks (ya es filesystem-
# backed), execution log (escribe en cada run), y env vars (van como env
# reales del contenedor, no config versionada).

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

# WorkspaceManager (@ia-flow/agent-engine) shells out to `git clone` /
# `git worktree` / `git commit` for every anthropic-api run — needsWorkspace()
# gates on the provider id alone, not on the agent's tools. -slim doesn't
# ship git, so any real run would fail with ENOENT without this.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/package.json package.json
COPY packages/shared packages/shared
COPY packages/ai-providers packages/ai-providers
COPY packages/issue-sources packages/issue-sources
COPY packages/agent-engine packages/agent-engine
COPY packages/tools packages/tools
COPY apps/server apps/server

# Config fija de este deploy. Editar cualquiera de estos YAML + reconstruir
# (o bind-mount en runtime, ver README.md) es la forma de cambiarlos —
# los cuatro son read-only en modo yaml (Yaml*Repository tira si algo
# intenta escribir). Variante github-issues por default: para la variante
# Projects v2 (agents.refiner.yaml), swappeá la línea del roster de agentes
# de abajo — projects.yaml/repos.yaml/mcp-catalog.yaml siguen siendo los
# mismos, solo ajustá su contenido al source real.
COPY agents/functional-refiner/agents.refiner.github-issues.yaml /app/config/agents.yaml
COPY agents/functional-refiner/projects.yaml /app/config/projects.yaml
COPY agents/functional-refiner/repos.yaml /app/config/repos.yaml
COPY agents/functional-refiner/mcp-catalog.yaml /app/config/mcp-catalog.yaml

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
    PORT=3001

# /data sigue existiendo para lo que no puede ser estático: tasks
# (filesystem-backed ya, bajo /data/tasks), execution log (SQLite, escribe
# en cada run), y las tablas `agents`/`projects`/`repos`/`mcp_catalog` que
# este roster no usa (quedan vacías — getDb() no es condicional, la
# conexión se abre igual). El resto (statuses, system_prompts,
# global_settings, prompts) sigue en SQLite activo por default y SÍ se
# puede leer/editar normal si algún día lo necesitás (UI, CRUD) — no está
# "apagado", solo no lo usa este roster puntual.
VOLUME ["/data"]
EXPOSE 3001

WORKDIR /app/apps/server
CMD ["bun", "run", "prod"]
