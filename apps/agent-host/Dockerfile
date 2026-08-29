# ia-flow — el agent-host de providers de IA (apps/agent-host).
#
# Corre agentes en la máquina que tiene lo que el server no tiene: las
# credenciales reales, el CLI `claude`, o el filesystem con los repos. Se
# registra por HTTP contra un server/runner y este decide si le manda trabajo.
#
# Build context: la RAÍZ del repo. Ver "Imágenes" en el CLAUDE.md de la raíz.
#
#   podman build -f apps/agent-host/Dockerfile -t ia-flow-agent-host .
#
# ── Por qué esta imagen NO enumera paquetes ──────────────────────────────
#
# Antes copiaba manifest por manifest y carpeta por carpeta, y corría
# `bun install` en la imagen final. Esa lista **se pudrió**: cuando se creó
# `packages/github-auth` nadie la actualizó, y el build empezó a morir con
#
#     error: @ia-flow/github-auth@workspace:* failed to resolve
#
# Una lista a mano que hay que mantener sincronizada con el grafo de imports
# real es una lista que se desincroniza. `bun build` sigue ese grafo solo, así
# que no hay nada que mantener: agregar una dependencia nueva no toca este
# archivo. Es el mismo criterio que usa apps/server/Dockerfile.runner.
#
# Efecto secundario que importa: la etapa de runtime queda SIN `node_modules`.
# Por eso el logger del agent-host no puede usar `pino.transport` — sus targets se
# resuelven en runtime dentro de un worker y ahí no hay nada que resolver. Ver
# el bloque de sinks en apps/agent-host/src/logger.ts.
# `1.1.30` pinneado, no `1` (que resuelve al último 1.x, hoy 1.4.x).
#
# No es prolijidad: Bun 1.4.x cambió el transform de decorators legacy y rompe
# `@memoize` (packages/shared/src/cache.ts), que está en el grafo de esta
# imagen. `.github/workflows/ci.yml` ya lo pinea por eso mismo — sin este pin,
# CI validaba con una versión y las imágenes publicadas se construían con la
# que el propio repo documenta como rota. Se despinea junto con CI, cuando el
# issue #80 migre `@memoize`.
FROM oven/bun:1.1.30 AS build
WORKDIR /app

COPY . .
RUN bun install --frozen-lockfile \
 && bun build --target=bun apps/agent-host/src/index.ts --outfile=/app/agent-host.js

FROM oven/bun:1.1.30-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# `git` + CAs para el provisioner de workspace: un run remoto sobre un repo que
# esta máquina nunca vio lo clona (`AGENT_HOST_REPOS_BASE`). Sin el bundle de CAs
# un `git clone https://github.com/...` falla con "server certificate
# verification failed" en una base slim.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# El bundle es autosuficiente: un solo archivo y nada al lado.
COPY --from=build /app/agent-host.js /app/agent-host.js

# /state: lo que el agent-host persiste — su `agent-host.json` (contra qué servers se
# registra, su cap de concurrencia) y, si se usa el provisioner, los clones y
# worktrees de los repos. Un deploy que escribe código necesita este volumen
# dimensionado para sus repos, no para unos KB de bookkeeping.
ENV IA_FLOW_CONFIG_DIR=/state \
    PORT=3002 \
    LOG_PLAIN=true \
    IA_FLOW_AGENT_HOST_LOG_FILE=""
VOLUME ["/state"]

# `LOG_PLAIN=true` deja NDJSON crudo en stdout, que es lo que un runtime de
# contenedores sabe juntar; los colores de pino-pretty serían basura ahí.
# `IA_FLOW_AGENT_HOST_LOG_FILE=""` apaga el archivo por el mismo motivo: en un
# filesystem efímero es un log que nadie va a leer nunca.

# `claude-print` necesita el CLI `claude` en el PATH — instalalo acá o montalo
# desde el host si vas a registrar ese provider. `anthropic-api` no lo necesita
# y es el que corre por default.

# Non-root: Pod Security Standards en `restricted` rechaza un contenedor que
# corre como root. La base ya trae el usuario `bun` (uid 1000); lo que falta es
# que /state le pertenezca, porque ahí escribe su estado.
RUN mkdir -p /state && chown -R bun:bun /state
USER bun

EXPOSE 3002

ENTRYPOINT ["bun", "run", "/app/agent-host.js"]
