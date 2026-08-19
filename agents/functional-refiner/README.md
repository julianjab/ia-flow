# Engine headless — solo agente de refinación

Imagen mínima que corre únicamente `apps/server` (Hono API + daemon, sin la
SPA web), con **toda su config estática**: roster de agentes, catálogo MCP,
proyecto, statuses, repo, system prompts, settings y prompts salen de
archivos YAML en esta carpeta en vez de la tabla SQLite correspondiente —
`IA_FLOW_REPO_SOURCE=yaml` (ver
[`infrastructure/db/index.ts`](../../apps/server/src/infrastructure/db/index.ts),
`pickRepo`/`resolveRepoSource`) aplica eso a los 8 repos dual-source de una
sola vez.

Cada `Yaml*Repository` (`apps/server/src/infrastructure/db/yaml/`) es de
solo lectura — para cambiar cualquiera de estos archivos hay que editarlo y
reconstruir la imagen (o remontarlo, ver "Cambiar el roster" más abajo) y
reiniciar el contenedor. Lo único que sigue en SQLite/filesystem bajo
`/data` es lo que no puede ser estático: tasks (ya es filesystem-backed),
execution log (escribe una fila por run) y env vars (van como env reales
del contenedor, nunca versionadas en git — ver `refiner.env.example`).

Toda la definición de este agente containerizado vive en esta carpeta
(`agents/functional-refiner/`): `Dockerfile`, `docker-compose.yml`, los
YAML de config (roster, mcp-catalog, projects, statuses, repos,
system-prompts, settings, prompts) y el `.env` con sus credenciales.

**Antes de buildear**, completá los placeholders (`mi-org`, `mi-repo`,
`/data/repos/mi-repo`) en `projects.yaml` y `repos.yaml` con los valores
reales de tu repo — y cloná ese repo dentro del volumen `/data/repos/` (o
montalo) antes de levantar el contenedor: `repos.yaml` declara `path` de
antemano porque este repo es read-only y no puede cachear un path de clone
como hace la versión SQLite (ver el comentario en el archivo).

## Run (docker-compose / podman-compose — recomendado)

Un solo servicio (`refiner`) definido en `docker-compose.yml`, en esta
carpeta. El server principal sigue corriendo en el host con `bun run
dev:server` — el compose no lo toca.

```bash
cd agents/functional-refiner
cp refiner.env.example .env   # completar valores reales
docker compose up -d --build  # o: podman compose up -d --build
```

Esto hace build + run + reinicia solo (`restart: unless-stopped`), mapea el
contenedor a `127.0.0.1:3002` (no `3001`, para no chocar con el server
principal del host) y deja `/data` en un volumen nombrado
(`ia-flow-refiner-data`) — sobrevive a `docker compose down` (sin `-v`).
El build usa el repo entero como contexto (`context: ../..` en el compose,
el Dockerfile necesita todo el workspace de Bun) aunque el `docker-compose.yml`
mismo esté acá.

Ver `refiner.env.example` (en esta carpeta) para las vars: `ANTHROPIC_API_KEY`,
`GITHUB_TOKEN`, `IA_FLOW_WEBHOOK_SECRET`, y opcionalmente
`IA_FLOW_REMOTE_LOG_TOKEN` para que el refiner reenvíe sus logs al server
principal (ver sección "Logs" más abajo).

## Build/Run manual (sin compose)

```bash
# Desde la raíz del repo — el build context tiene que ser el workspace
# completo, no esta carpeta.
podman build -t ia-flow-refiner-engine -f agents/functional-refiner/Dockerfile .

podman run -d --name ia-flow-refiner \
  -p 127.0.0.1:3002:3001 \
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
- `-p 127.0.0.1:3002:3001`, no `-p 3002:3001`: el server no tiene auth propia
  y `/api/*` incluye CRUD de projects/tasks + el `GITHUB_TOKEN` ya cargado en
  el proceso — publicarlo en todas las interfaces expone eso a la red. Si
  necesitás exponerlo, ponelo detrás de un reverse proxy con auth, o usá el
  túnel de Cloudflare que ya trae el server (`apps/server/CLAUDE.md`).
- El proyecto/GitHub Project contra el que corre el refiner sale de
  `projects.yaml` (+ `repos.yaml`/`statuses.yaml`) en esta carpeta, no de
  `POST /api/projects` en runtime — completá esos archivos antes de
  buildear (ver arriba). Si preferís seguir configurándolo vía API contra
  SQLite como antes, quitá `IA_FLOW_REPO_SOURCE=yaml` del Dockerfile (o
  overrideá el repo puntual con `IA_FLOW_PROJECT_REPO=sqlite`, etc. — cada
  repo tiene su propio override, ver `infrastructure/db/index.ts`).

## Cambiar la config (roster, mcp catalog, proyecto, statuses, repo, ...)

Mismo mecanismo para cualquiera de los 8 archivos YAML de esta carpeta —
dos formas, sin tocar código:

1. **Editar y reconstruir:** modificá el archivo que corresponda,
   `podman build` de nuevo.
2. **Bind-mount en runtime** (sin rebuild), montando sobre el path
   `/app/config/<archivo>` que el Dockerfile ya define (ver `ENV
   IA_FLOW_*_FILE` ahí):
   ```bash
   podman run ... -v ./mi-agents.yaml:/app/config/agents.yaml:ro ia-flow-refiner-engine
   ```

Para volver al modo SQLite normal (multi-proyecto, editable desde la UI vía
CRUD), corré `apps/server` sin `IA_FLOW_REPO_SOURCE=yaml` — la imagen y el
código soportan ambos modos, la variable de entorno decide cuál usa
`container.ts`. También podés mezclar: dejar `IA_FLOW_REPO_SOURCE=yaml`
global pero overridear un repo puntual a SQLite con su env var específica
(ej. `IA_FLOW_SETTINGS_REPO=sqlite`) si necesitás que ESE dato en particular
siga siendo editable en runtime — el override por-repo siempre gana sobre
la global (ver `infrastructure/db/index.ts`, `resolveRepoSource`).

### Variante: issues de un repo de GitHub directo (sin Project board)

[`agents.refiner.github-issues.yaml`](./agents.refiner.github-issues.yaml) es
para proyectos de ia-flow con source `kind: 'github-issues'`
(`packages/issue-sources/src/github-issues/`) — issues sueltos de UN repo,
sin pasar por un GitHub Project v2. Usalo (bind-mount, opción 2 de arriba) en
vez del default cuando el proyecto que este roster atiende fue creado con:

```bash
curl -X POST http://localhost:3001/api/projects \
  -H 'content-type: application/json' \
  -d '{
    "name": "mi-repo",
    "source": {
      "kind": "github-issues",
      "config": { "owner": "mi-org", "repo": "mi-repo", "anchorLabel": "ia-flow" }
    }
  }'
```

Este YAML **no** configura el source (`owner`/`repo`/`anchorLabel`) — eso es
config del proyecto, vía la API de arriba. El YAML solo define el roster de
agentes que corren contra ese proyecto.

Diferencia principal con `agents.refiner.yaml`: este roster no usa
`set_task_field` para resolver épica-vs-task por cardinalidad de repos —
un source `github-issues` está atado a un solo repo por diseño, así que
`task.repos` ya llega resuelto sin ambigüedad y no hay campo "Repos" que
setear (ese es un concepto de Projects v2). `GitHubIssueTaskSource` sí
implementa `setFields` (para "Status" hace la misma mutación de label que
`applyTransition`; cualquier otro campo queda solo en memoria — GitHub
issues no tienen campos custom nativos), así que `set_task_field` no
rompería si algún otro agente lo llamara, solo que este roster no lo
necesita. `statusName`/`onFinish`/`onError` funcionan igual que siempre
(`ITaskSource.applyTransition` es provider-agnostic), solo que mueven la
label `status:<nombre>` del issue en vez de un campo del board — comparación
case-insensitive en ambos casos. Antes de correr esto contra un repo real,
creá las labels `status:refine`/`status:refined`/`status:blocked` (o los
nombres que uses) y la label ancla (`anchorLabel`) en los issues que querés
que el engine tome.

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
