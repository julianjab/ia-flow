# Engine headless — implementer contra julianjab/accountant

Imagen mínima que corre únicamente `apps/server` (Hono API + daemon, sin la
SPA web), calcada de [`agents/functional-refiner/`](../functional-refiner/)
pero para el paso de **implementación**: un solo agente
(`accountant-implementer`) que toma issues del repo
[`github.com/julianjab/accountant`](https://github.com/julianjab/accountant)
y escribe código real — branch, commits y Pull Request — usando el **MCP
oficial de GitHub**, sin checkout local (el agente no tiene `fs_write`ni
`bash_run`, solo `mcpCatalogIds: [github-mcp]`; ver
`agents.implementer.yaml`).

Mismos 4 YAML dual-source que el refiner (agentes, proyecto, repo, catálogo
MCP) vía sus env vars puntuales — ver el README del refiner para el
razonamiento completo de por qué alcanza con 4 en vez de 8. Statuses,
system prompts, settings y prompts quedan en SQLite normal, sin usar.

## Flujo de labels (status vía label, un solo `status:*` a la vez)

Este source es `github-issues` (`packages/issue-sources/src/github-issues/`),
así que el status del issue vive en un label `status:<nombre>`, y
`StatusLabelCodec` garantiza que solo hay UNO presente a la vez (mutación
reemplaza, no acumula). El roster define:

| Paso | Label antes | Trigger | Label después |
| --- | --- | --- | --- |
| Toma la tarea | `status:build` | `statusName: build` matchea | — |
| Empieza a correr | `status:build` | `onProcess` | `status:working` |
| Termina bien (PR abierto + comentario en el issue) | `status:working` | `onFinish` | `status:done` |
| Falla (excepción, PR rechazado, PRD incompleto) | `status:working` | `onError` | `status:blocked` |

`statusName: build` ya es la única condición de entrada — un issue en
`status:working`/`status:done`/`status:blocked` **no puede** tener también
`status:build` (un solo label a la vez), así que el engine nunca lo vuelve a
tomar mientras está en cualquiera de esos otros 3 estados. No hace falta un
`when` adicional para excluirlos explícitamente; agregar uno sería
redundante con esta garantía del codec (ver comentario en
`agents.implementer.yaml`).

Antes de correr esto contra el repo real, creá en
`github.com/julianjab/accountant`:

- Las labels `status:build`, `status:working`, `status:done`, `status:blocked`.
- La label ancla `ia-flow-build` (`anchorLabel` en `projects.yaml`) en cada
  issue que querés que el engine tome — normalmente el issue ya viene con
  un PRD funcional aprobado (paso previo de refinamiento, fuera del alcance
  de este deploy).

## Auth de Claude — CLAUDE_CODE_OAUTH_TOKEN, no ANTHROPIC_API_KEY

El provider sigue siendo `anthropic-api` (`AnthropicApiProvider.id`, ver
`agents.implementer.yaml`) — lo que cambia es la credencial. Este deploy usa
`CLAUDE_CODE_OAUTH_TOKEN`: `buildAnthropicAuthHeader`
(`packages/ai-providers/src/anthropic-api/auth.ts`) lo prioriza sobre
`ANTHROPIC_API_KEY` cuando ambos están seteados, así que alcanza con setear
uno solo. Generalo con `claude setup-token` desde el CLI de Claude Code (o
donde ya tengas uno emitido para uso headless/CI) y pegalo en `.env`.

## GitHub — token, no GitHub App

`GITHUB_TOKEN` es un **Personal Access Token** (classic o fine-grained) con
permisos de escritura sobre `contents`, `pull_requests` e `issues` del repo
`accountant` — lo consume tanto el source `github-issues` (leer/mover el
issue) como el MCP remoto de GitHub (escribir el código), mismo token para
los dos (ver `mcp-catalog.yaml`). No hace falta una GitHub App instalada:
si ya tenés una app propia en
[github.com/settings/apps](https://github.com/settings/apps), no es lo que
este deploy usa — generá el token en
[github.com/settings/tokens](https://github.com/settings/tokens) (o
fine-grained en `settings/personal-access-tokens`) apuntado al repo
`julianjab/accountant`.

## URL del túnel + secret del webhook

Este deploy corre en modo `webhook` (default del daemon) y necesita una URL
pública para que GitHub le pueda hacer POST. El contenedor **no** abre ni
administra ningún túnel — `entrypoint.sh` arranca `apps/server` y, junto a
él, un proxy standalone (`scripts/webhook-proxy.ts`) que sólo reenvía
`POST /api/webhooks/github` (404 a todo lo demás) en el puerto `8787`,
mapeado al host en `docker-compose.yml`. El túnel público se corre **a
mano, en el host**, apuntando a ese puerto:

```bash
cloudflared tunnel --url http://localhost:8787   # o ngrok http 8787, etc.
```

Dejalo corriendo en un proceso persistente (tmux, una LaunchAgent) — sobrevive
a un `docker compose restart` del contenedor, porque vive completamente
afuera de él.

Al terminar de arrancar el contenedor, **mirá los logs** para el secret que
hay que pegar en GitHub:

```bash
docker compose logs -f implementer   # o: podman compose logs -f implementer
```

```
==================================================================
 GitHub webhook — Settings > Webhooks > Add webhook, en
 github.com/julianjab/accountant

   Content type: application/json
   Secret:       a1b2c3...
   Eventos:      Issues, Issue comment
==================================================================
```

- **Payload URL:** `<url-del-túnel>/api/webhooks/github` — depende del túnel
  que corras en el host, no de nada que imprima el contenedor. Si usás un
  quick tunnel gratis sin dominio propio, cambia cada vez que reiniciás *el
  túnel* (no el contenedor).
- **Secret:** si no seteaste `IA_FLOW_WEBHOOK_SECRET` en `.env`,
  `entrypoint.sh` genera uno al primer boot y lo persiste en
  `/data/webhook-secret` (el volumen nombrado) — sobrevive a restarts del
  contenedor.
- Si preferís un secret propio y estable desde el arranque, seteá
  `IA_FLOW_WEBHOOK_SECRET` en `.env` — `entrypoint.sh` lo respeta y no
  genera ninguno.
- El puerto `3001` (API completa, sin auth propia) **no** se publica al
  host — el único puerto mapeado es el `8787` del proxy.

## Run (docker-compose / podman-compose — recomendado)

```bash
cd agents/implementer-accountant
cp implementer.env.example .env   # completar CLAUDE_CODE_OAUTH_TOKEN, GITHUB_TOKEN, etc.
docker compose up -d --build      # o: podman compose up -d --build
```

Mapea el proxy de webhooks del contenedor a `127.0.0.1:8787` (el único
puerto publicado — ni el `3001` de este deploy ni los de los otros dos, el
`3002` del refiner y el `3003` que usaba este mismo deploy antes de sacar el
túnel de la app) y deja `/data` en un volumen nombrado
(`ia-flow-implementer-accountant-data`) — sobrevive a `docker compose down`
(sin `-v`). El build usa el repo entero como contexto
(`context: ../..`), aunque el `docker-compose.yml` esté en esta carpeta.

## Build/Run manual (sin compose)

```bash
# Desde la raíz del repo
podman build -t ia-flow-implementer-accountant -f agents/implementer-accountant/Dockerfile .

podman run -d --name ia-flow-implementer-accountant \
  -p 127.0.0.1:8787:8787 \
  -v ia-flow-implementer-accountant-data:/data \
  -e CLAUDE_CODE_OAUTH_TOKEN=... \
  -e GITHUB_TOKEN=ghp_... \
  ia-flow-implementer-accountant

podman logs -f ia-flow-implementer-accountant   # ver el secret del webhook
```

Modo `webhook` (default) — ver "URL del túnel + secret del webhook" arriba
para correr el túnel a mano en el host apuntando a `:8787`. No hace falta
pasar `IA_FLOW_WEBHOOK_SECRET`: se genera y persiste solo en `/data`. Si
preferís `polling` (sin túnel, pull cada `IA_FLOW_POLL_INTERVAL_MS`), agregá
`-e IA_FLOW_DAEMON_MODE=polling` — el proxy sigue levantado igual, simplemente
no hace falta un túnel apuntándole.

`IA_FLOW_DAEMON_MODE=polling` es el modo más simple para probar sin exponer
nada a internet — el modo default `webhook` no dispara nada hasta que llegue
un delivery real (ver `apps/server/CLAUDE.md`).
`-p 127.0.0.1:8787:8787`, no `-p 8787:8787`: aunque el proxy sólo reenvía
`/api/webhooks/github`, no hay razón para exponerlo a la LAN — el túnel lo
alcanza igual por loopback.

## Cambiar la config (roster, proyecto, repo, catálogo MCP)

Igual que en `functional-refiner`: editar + reconstruir, o bind-mount en
runtime sobre `/app/config/<archivo>` (ver el `ENV IA_FLOW_*_FILE` del
Dockerfile y las líneas comentadas en `docker-compose.yml`).

## Logs

Mismo mecanismo que el refiner: `daemon.log` siempre local bajo
`/data/logs` (y `docker compose logs -f implementer` / `podman compose logs
-f implementer` para verlo en vivo, incluido el bloque de Payload
URL + secret que imprime `entrypoint.sh`).

Forward opcional a `POST /api/remote-logs` del server principal — **no
viene activado por default en este compose** (ver nota de `extra_hosts` en
`docker-compose.yml`: `host.docker.internal` + `host-gateway` tiene un bug
conocido en Podman/macOS, `podman machine stop && podman machine start`
suele arreglarlo). Para activarlo: agregá de nuevo el bloque `extra_hosts`
comentado en `docker-compose.yml` y seteá `IA_FLOW_REMOTE_LOG_URL` +
`IA_FLOW_REMOTE_LOG_TOKEN` en tu `.env` (el server principal necesita el
mismo token o rechaza con 503).

## Notas Podman

Es un Dockerfile OCI estándar — `docker build`/`docker run` funcionan igual.
En macOS con Podman, arrancá la VM primero: `podman machine start`.
