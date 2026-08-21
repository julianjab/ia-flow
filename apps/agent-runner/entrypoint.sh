#!/bin/sh
# Arranca apps/server y, solo en modo webhook (el default del daemon si
# IA_FLOW_DAEMON_MODE queda sin setear — ver apps/server/CLAUDE.md), además
# el proxy standalone de webhooks (scripts/webhook-proxy.ts) — imprimiendo en
# el log del contenedor el secret que hay que pegar en GitHub.
#
# En modo polling (IA_FLOW_DAEMON_MODE=polling) el proxy ni arranca: el
# server hace polling propio contra el issue source, no necesita que nada le
# llegue por HTTP desde afuera.
#
# Este contenedor NUNCA abre ni administra un túnel — en modo webhook eso
# vive fuera, en el host, apuntando al puerto del proxy (IA_FLOW_PROXY_PORT)
# mapeado en tu docker-compose.yml. Ver README.md de esta carpeta.
set -eu

PORT="${PORT:-3001}"
PROXY_PORT="${IA_FLOW_PROXY_PORT:-8787}"
DAEMON_MODE="${IA_FLOW_DAEMON_MODE:-webhook}"
SECRET_FILE=/data/webhook-secret

cd /app/apps/server
bun run prod &
SERVER_PID=$!

if [ "$DAEMON_MODE" = "webhook" ]; then
  # El daemon falla cerrado (503) sin IA_FLOW_WEBHOOK_SECRET. Si no vino por
  # env, generamos uno y lo persistimos en /data (el volumen del contenedor)
  # para que sobreviva a un restart: si cambiara en cada boot, el secret
  # configurado en GitHub dejaría de matchear.
  if [ -z "${IA_FLOW_WEBHOOK_SECRET:-}" ]; then
    if [ -f "$SECRET_FILE" ]; then
      IA_FLOW_WEBHOOK_SECRET="$(cat "$SECRET_FILE")"
    else
      IA_FLOW_WEBHOOK_SECRET="$(head -c32 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c40)"
      echo "$IA_FLOW_WEBHOOK_SECRET" > "$SECRET_FILE"
    fi
    export IA_FLOW_WEBHOOK_SECRET
  fi

  cd /app
  IA_FLOW_API_PORT="$PORT" IA_FLOW_PROXY_PORT="$PROXY_PORT" bun run scripts/webhook-proxy.ts &
  PROXY_PID=$!
  # Matar ambos procesos si uno de los dos muere, o si `docker stop` manda TERM.
  trap 'kill "$SERVER_PID" "$PROXY_PID" 2>/dev/null || true' TERM INT EXIT
else
  # Sin proxy en modo polling — solo matar el server si `docker stop` manda TERM.
  trap 'kill "$SERVER_PID" 2>/dev/null || true' TERM INT EXIT
fi

echo "[entrypoint] Esperando a que el server responda en :$PORT..."
i=0
until curl -fs "http://localhost:$PORT/api/webhooks/status" >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 30 ]; then
    echo "[entrypoint] El server no respondió a tiempo — revisá los logs de arriba."
    break
  fi
  sleep 1
done

if [ "$DAEMON_MODE" = "webhook" ]; then
  echo ""
  echo "=================================================================="
  echo " GitHub webhook — Settings > Webhooks > Add webhook, en el repo"
  echo " que configuraste en tus YAML (${IA_FLOW_RUNNER_REPO_LABEL:-ver repos.yaml})"
  echo ""
  echo "   Content type: application/json"
  echo "   Secret:       $IA_FLOW_WEBHOOK_SECRET"
  echo "   Eventos:      Issues, Issue comment"
  echo ""
  echo " Este contenedor no abre ningún túnel. El proxy en :$PROXY_PORT sólo"
  echo " expone POST /api/webhooks/github (404 a todo lo demás) — corré un"
  echo " túnel desde tu host apuntando al puerto mapeado de ese proxy, ej.:"
  echo "   cloudflared tunnel --url http://localhost:<puerto-host-del-proxy>"
  echo " La Payload URL a pegar en GitHub es <url-del-túnel>/api/webhooks/github."
  echo "=================================================================="
  echo ""
fi

wait "$SERVER_PID"
