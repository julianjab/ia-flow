# ia-flow — el engine headless (flavor `runner` de apps/server).
#
# Build context: la RAÍZ del repo. Ver containers/README.md.
#
#   podman build -f containers/runner/Dockerfile -t ia-flow-runner .
#
# ── Qué cambió respecto de apps/agent-runner/Dockerfile ──────────────────
#
# 1. **No enumera paquetes.** Aquel copiaba manifest por manifest y carpeta
#    por carpeta (unas 20 líneas) y dejaba `node_modules` entero en la imagen
#    final. `bun build` sigue el grafo de imports solo: 665 módulos → un
#    archivo de ~1.6 MB, y la etapa de runtime no instala nada.
#
# 2. **No trae `git`.** El flavor `runner` no inyecta provisioner de
#    workspace, así que `AnthropicApiProvider.prepareWorkspace` devuelve
#    EMPTY_WORKSPACE_PLAN: cero `git clone`, cero worktrees. El roster lee y
#    escribe por el MCP de GitHub.
#
# 3. **No trae `curl` ni un entrypoint.sh.** El proxy de webhooks
#    (`scripts/webhook-proxy.ts`) existía para no exponer una API sin auth
#    propia; este flavor no tiene esa API — su superficie es
#    POST /api/webhooks/github y /health. Un proceso, sin wait-loop y sin trap.
#
# 4. **No fija 12 ENV.** Los 8 `IA_FLOW_*_REPO`/`*_FILE` no se leen (la rama
#    `runner` de pickRepo gana antes), y el resto se declara en el runner.yaml.

# `--platform=linux/amd64` fijo: los nodos del cluster son amd64 (m7i-flex,
# m5a, t3a — Graviton llevaría `g` en la familia) y esta imagen se construye
# desde una Mac arm64. Una imagen de la arquitectura equivocada NO falla al
# construirse ni al pushearse a ECR: falla en el pod, con `exec format error`,
# cuando ya está desplegada. Si algún día aparece un nodegroup Graviton, esto
# pasa a `buildx --platform linux/amd64,linux/arm64`.
FROM --platform=linux/amd64 oven/bun:1 AS build
WORKDIR /app

COPY . .
RUN bun install --frozen-lockfile \
 && bun build --target=bun apps/server/src/main.ts --outfile=/app/server.js

# `--target=bun`, no `--compile`. El binario standalone (59 MB, sin runtime de
# Bun en la base) es el próximo paso, pero antes hay que resolver tres usos de
# `import.meta.dir` que sobreviven literales al bundle: los prompts .md de las
# migraciones 029/031/032/033, TASKS_ROOT en composition/container.ts y
# HOOK_TOOL_USE_PATH en terminal/base.ts. Los .md se copian abajo; los otros
# dos no entran en el grafo de este flavor.

FROM --platform=linux/amd64 oven/bun:1-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/server.js /app/server.js
# Único activo que el bundle no puede llevarse adentro: cuatro migraciones
# leen sus prompts con `join(import.meta.dir, 'NNN-prompts')`, y en un bundle
# `import.meta.dir` es el directorio del .js — o sea /app. De ahí que vayan
# ahí y no bajo migrations/. Un COPY por carpeta, no un glob: con varias
# fuentes Docker aplana el contenido y perdería el nombre del directorio, que
# es justo la parte que el path del código nombra.
COPY --from=build /app/apps/server/src/migrations/028-prompts /app/028-prompts
COPY --from=build /app/apps/server/src/migrations/031-prompts /app/031-prompts
COPY --from=build /app/apps/server/src/migrations/032-prompts /app/032-prompts
COPY --from=build /app/apps/server/src/migrations/033-prompts /app/033-prompts

# /app/config queda vacío a propósito — el runner.yaml entra por bind-mount en
# runtime (ver deploys/*/docker-compose.yml), así que la MISMA imagen sirve
# para cualquier roster sin rebuild.
RUN mkdir -p /app/config

# /state: lo único que este flavor persiste. El estado real vive en GitHub
# (labels, comentarios); acá quedan el secret del webhook y el execution log.
ENV IA_FLOW_CONFIG_DIR=/state \
    IA_FLOW_DB_PATH=/state/ia-flow.sqlite \
    LOG_PLAIN=true
VOLUME ["/state"]

# Non-root: Pod Security Standards en `restricted` rechaza un contenedor que
# corre como root. La imagen base ya trae el usuario `bun` (uid 1000); lo que
# falta es que /state le pertenezca, porque ahí escribe la SQLite y el secret
# del webhook.
RUN mkdir -p /state && chown -R bun:bun /state /app/config
USER bun

# El puerto del webhook. Es el único pensado para recibir tráfico, vía un
# túnel corrido en el host — este contenedor nunca abre ni administra uno.
EXPOSE 3001

ENTRYPOINT ["bun", "run", "/app/server.js"]
CMD ["runner"]
