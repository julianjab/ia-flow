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

## Build

```bash
podman build -t ia-flow-refiner-engine -f Dockerfile .
```

(Corre desde la raíz del repo — el Dockerfile necesita todo el workspace de
Bun, aunque solo empaqueta `apps/server` + `packages/*` en la imagen final.)

## Run

```bash
podman run -d --name ia-flow-refiner \
  -p 3001:3001 \
  -v ia-flow-refiner-data:/data \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e GITHUB_TOKEN=ghp_... \
  -e IA_FLOW_WEBHOOK_SECRET=algo-random \
  -e IA_FLOW_DAEMON_MODE=polling \
  ia-flow-refiner-engine
```

- `ANTHROPIC_API_KEY` / `GITHUB_TOKEN` — obligatorios para que el provider y
  el source de GitHub Projects funcionen.
- `IA_FLOW_DAEMON_MODE=polling` es el modo más simple para probar sin exponer
  el contenedor a internet (sin esto, el modo default `webhook` no dispara
  nada hasta que llegue un delivery real — ver `apps/server/CLAUDE.md`).
- `IA_FLOW_WEBHOOK_SECRET` solo hace falta en modo webhook.
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

## Notas Podman

Es un Dockerfile OCI estándar — `docker build`/`docker run` funcionan igual.
En macOS con Podman, arrancá la VM primero: `podman machine start`.
