# Imagen mínima para correr apps/ai-provider-gateway como contenedor,
# separado del server principal — pensado para vivir en la máquina que
# tiene las credenciales reales (ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN,
# y el CLI `claude` instalado si se usa el provider claude-print).
#
# Sin build compilado: Bun corre TS directo, así que no hace falta un
# multi-stage — se instalan deps y se copia el código de los workspaces que
# esta app realmente usa (no todo el monorepo).
FROM oven/bun:1

WORKDIR /app

# Copiamos primero los manifests para cachear `bun install` entre builds
# cuando solo cambia código, no dependencias.
COPY package.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/ai-providers/package.json packages/ai-providers/package.json
COPY packages/tools/package.json packages/tools/package.json
COPY packages/issue-sources/package.json packages/issue-sources/package.json
COPY packages/agent-engine/package.json packages/agent-engine/package.json
COPY apps/ai-provider-gateway/package.json apps/ai-provider-gateway/package.json

RUN bun install

COPY packages/shared packages/shared
COPY packages/ai-providers packages/ai-providers
COPY packages/tools packages/tools
COPY packages/issue-sources packages/issue-sources
COPY packages/agent-engine packages/agent-engine
COPY apps/ai-provider-gateway apps/ai-provider-gateway

# claude-print necesita el CLI `claude` en PATH — instalalo en la imagen (o
# montalo desde el host) si vas a registrar ese provider; anthropic-api no
# lo necesita.

EXPOSE 3002

ENV PORT=3002

CMD ["bun", "run", "--cwd", "apps/ai-provider-gateway", "start"]
