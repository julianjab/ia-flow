# llm-gateway en Cloud Run.
#
# El contexto es `apps/llm-gateway/dist/`, con el bundle que arma `bun run bundle`
# (desde apps/llm-gateway: así Bun toma `experimentalDecorators` de su tsconfig).
# Sin `bun install` en la imagen: el bundle ya trae todo.
#
#   bun run --cwd apps/llm-gateway bundle
#   docker build -f apps/llm-gateway/deploy/Dockerfile apps/llm-gateway/dist
FROM oven/bun:1.4.2-slim

WORKDIR /app
COPY gateway.js .

# Cloud Run manda el tráfico a 8080 y necesita que se escuche en todas las interfaces.
# El token del gateway y el de Claude llegan como secretos, nunca en la imagen.
ENV LLM_GATEWAY_HOST=0.0.0.0 \
    LLM_GATEWAY_PORT=8080
EXPOSE 8080

USER bun
CMD ["bun", "gateway.js"]
