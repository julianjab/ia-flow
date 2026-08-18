# Engine headless — solo agente de refinación

Imagen mínima que corre únicamente `apps/server` (Hono API + daemon, sin la
SPA web), con el roster de agentes fijado a un único agente
(`functional-refiner`) vía [`agents.refiner.yaml`](./agents.refiner.yaml) en
vez de la tabla `agents` de SQLite.

Ver [`YamlAgentRepository`](../src/infrastructure/yaml/YamlAgentRepository.ts):
es de solo lectura — para cambiar el roster hay que editar el YAML y
reconstruir la imagen (o remontar el archivo) y reiniciar el contenedor.
El resto del estado (tasks, projects, statuses, execution log) sigue en
SQLite, persistido en el volumen `/data`.

## Run (docker-compose / podman-compose — recomendado)

Un solo servicio (`refiner`) definido en `docker-compose.yml`, en la raíz del
repo. El server principal sigue corriendo en el host con `bun run
dev:server` — el compose no lo toca.

```bash
cp apps/server/docker/refiner.env.example .env   # completar valores reales
docker compose up -d --build                     # o: podman compose up -d --build
```

Esto hace build + run + reinicia solo (`restart: unless-stopped`), mapea el
contenedor a `127.0.0.1:3002` (no `3001`, para no chocar con el server
principal del host) y deja `/data` en un volumen nombrado
(`ia-flow-refiner-data`) — sobrevive a `docker compose down` (sin `-v`).

Ver `.env` de ejemplo (`apps/server/docker/refiner.env.example`) para las
vars: `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, `IA_FLOW_WEBHOOK_SECRET`, y
opcionalmente `IA_FLOW_REMOTE_LOG_TOKEN` para que el refiner reenvíe sus logs
al server principal (ver sección "Logs" más abajo).

## Build/Run manual (sin compose)

```bash
podman build -t ia-flow-refiner-engine -f Dockerfile .

podman run -d --name ia-flow-refiner \
  -p 127.0.0.1:3001:3001 \
  -v ia-flow-refiner-data:/data \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e GITHUB_TOKEN=ghp_... \
  -e IA_FLOW_WEBHOOK_SECRET=algo-random \
  -e IA_FLOW_DAEMON_MODE=polling \
  ia-flow-refiner-engine
```

(Corre desde la raíz del repo — el Dockerfile necesita todo el workspace de
Bun, aunque solo empaqueta `apps/server` + `packages/*` en la imagen final.)

- `ANTHROPIC_API_KEY` / `GITHUB_TOKEN` — obligatorios para que el provider y
  el source de GitHub Projects funcionen.
- `IA_FLOW_DAEMON_MODE=polling` es el modo más simple para probar sin exponer
  el contenedor a internet (sin esto, el modo default `webhook` no dispara
  nada hasta que llegue un delivery real — ver `apps/server/CLAUDE.md`).
- `IA_FLOW_WEBHOOK_SECRET` solo hace falta en modo webhook.
- `-p 127.0.0.1:3001:3001`, no `-p 3001:3001`: el server no tiene auth propia
  y `/api/*` incluye CRUD de projects/tasks + el `GITHUB_TOKEN` ya cargado en
  el proceso — publicarlo en todas las interfaces expone eso a la red. Si
  necesitás exponerlo, ponelo detrás de un reverse proxy con auth, o usá el
  túnel de Cloudflare que ya trae el server (`apps/server/CLAUDE.md`).
- El proyecto/GitHub Project contra el que corre el refiner se configura
  igual que siempre, vía la API (`POST /api/projects`) — este Dockerfile no
  lo asume.

## Cambiar el roster

Dos formas, sin tocar código:

1. **Editar y reconstruir:** modificá `agents.refiner.yaml`, `podman build`
   de nuevo.
2. **Bind-mount en runtime** (sin rebuild):
   ```bash
   podman run ... -v ./mi-agents.yaml:/app/config/agents.yaml:ro ia-flow-refiner-engine
   ```

Para volver al modo SQLite normal (múltiples agentes, editables desde la UI),
corré `apps/server` sin `IA_FLOW_AGENT_REPO=yaml` — la imagen y el código
soportan ambos modos, la variable de entorno decide cuál usa `container.ts`.

## Logs

El contenedor siempre escribe su propio `daemon.log` (dentro del volumen
`/data/logs` — `IA_FLOW_CONFIG_DIR=/data` ya está seteado en el Dockerfile,
así que sobrevive a un restart del contenedor).

Adicional y opcional: si seteás `IA_FLOW_REMOTE_LOG_URL` +
`IA_FLOW_REMOTE_LOG_TOKEN` (el compose ya trae la URL por default apuntando
al host, solo falta el token — ver `refiner.env.example`), cada línea de log
del refiner **también** se reenvía a `POST /api/remote-logs` del server
principal, que la re-emite en su propio `daemon.log`/UI. El server principal
necesita la misma `IA_FLOW_REMOTE_LOG_TOKEN` en su entorno o rechaza el POST
con 503 (fail-closed, igual que `/api/webhooks/*`). Sin esas dos vars, el
comportamiento es el de siempre: solo archivo local.

## Notas Podman

Es un Dockerfile OCI estándar — `docker build`/`docker run` funcionan igual.
En macOS con Podman, arrancá la VM primero: `podman machine start`.
