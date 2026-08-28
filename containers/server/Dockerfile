# ia-flow — el server completo (flavor `full` de apps/server).
#
# La API entera + el WebSocket: las 24 rutas que consume `apps/web`, el
# dashboard, los logs en vivo, la edición de agentes. Es contra ESTO que
# apunta la app de escritorio (`IA Flow.app`) y contra lo que se registran los
# gateways.
#
# Build context: la RAÍZ del repo. Ver containers/README.md.
#
#   podman build -f containers/server/Dockerfile -t ia-flow-server .
#
# ── En qué se diferencia del runner ──────────────────────────────────────
#
# El `runner` es el mismo `apps/server` con otro entrypoint: escanea un board y
# despacha agentes, sin API que exponer, y su config entra por un `runner.yaml`
# bind-monteado. Este expone la API completa y su config vive en la base
# (editable desde la UI), así que NO lleva `/app/config` ni espera un YAML.
#
# Tampoco trae el toolchain de Python que el runner sí: ahí existe porque el
# reviewer de ese roster re-ejecuta lint y tests de repos Python. Un server
# genérico no sabe qué stack van a tener los repos de quien lo levante, y
# adivinar convertiría esta imagen en una imagen de CI.
#
# Sigue la MISMA regla que las otras dos: bundle, sin `node_modules` en
# runtime. Ver containers/README.md para la consecuencia que eso tiene al
# escribir código.
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
 && bun build --target=bun apps/server/src/entry/server.ts --outfile=/app/server.js

FROM oven/bun:1.1.30-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# `git` para el provisioner de workspace (clone + worktree + push), y las CAs
# que necesita: sin el bundle, un `git clone https://github.com/...` falla con
# "server certificate verification failed" en una base slim.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/server.js /app/server.js

# /state: la SQLite con TODA la config (proyectos, agentes, repos, prompts,
# env vars) más el execution log. A diferencia del runner —donde el estado real
# vive en GitHub y /state son unos KB de bookkeeping— acá el volumen ES el
# producto: perderlo es perder la configuración entera.
ENV IA_FLOW_CONFIG_DIR=/state \
    IA_FLOW_DB_PATH=/state/ia-flow.sqlite \
    IA_FLOW_TASKS_ROOT=/state/tasks \
    IA_FLOW_SERVER_PORT=3001 \
    LOG_PLAIN=true
VOLUME ["/state"]

# `IA_FLOW_TASKS_ROOT` es explícito y no un default: el source `local-fs` lo
# resuelve relativo al módulo, y en un bundle eso no apunta a ningún lado. Ver
# composition/container.ts.

# Non-root: Pod Security Standards en `restricted` rechaza un contenedor que
# corre como root. La base ya trae el usuario `bun` (uid 1000).
#
# /secrets/github-app: punto de montaje del PEM de la GitHub App, creado vacío.
# En Docker un bind-mount sobre un directorio inexistente lo crea ROOT y el
# proceso no root no puede atravesarlo. El PEM NO va adentro de la imagen.
RUN mkdir -p /state/tasks /secrets/github-app \
 && chown -R bun:bun /state /secrets \
 && chmod 0755 /secrets/github-app
USER bun

EXPOSE 3001

# ⚠️ La API NO tiene auth propia salvo que se configure `IA_FLOW_API_TOKEN`
# (ver routes/api-auth.ts). Publicá este puerto en loopback o detrás de algo
# que autentique — nunca directo a internet sin el token.
ENTRYPOINT ["bun", "run", "/app/server.js"]
