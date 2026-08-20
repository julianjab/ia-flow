# Engine headless — pipeline de 3 agentes contra la-haus/subscriptions

Imagen mínima que corre únicamente `apps/server` (Hono API + daemon, sin la
SPA web), calcada de [`agents/implementer-accountant/`](../implementer-accountant/)
en su infraestructura (proxy de webhooks standalone, túnel corrido a mano en
el host), pero con un roster de **3 agentes** en vez de 1, formando un
pipeline completo contra un solo repo: `github.com/la-haus/subscriptions`.

```
agent:refine → subscriptions-refiner     → escribe un PRD técnico en el issue
agent:build  → subscriptions-implementer → escribe el código, abre un PR
agent:review → subscriptions-ci-watcher  → mira el CI del PR, no mergea nunca
```

Los 3 agentes son `mcpCatalogIds: [github-mcp]` — ninguno tiene checkout
local (sin `fs_read`/`fs_write`/`bash_run`): todo el trabajo (leer código,
escribir archivos, abrir PR, mirar CI) sale por el **MCP oficial de GitHub**.
Mismos 4 YAML dual-source que `functional-refiner`/`implementer-accountant`
(agentes, proyecto, repo, catálogo MCP) — ver el README de `functional-refiner`
para el razonamiento completo de por qué alcanza con 4 en vez de 8.

## El pipeline en detalle

Este roster **no** usa `statusName`/`StatusLabelCodec` (el mecanismo estándar
de status vía un solo label `status:*` a la vez) — cada agente se gatea con
`when` sobre una label `agent:<nombre>` propia. Nada impide que convivan
varias `agent:*` labels a la vez si alguien las pone a mano; la disciplina de
"una sola por paso" la mantienen los `onProcess`/`onFinish`/`onError` de cada
agente en `agents.subscriptions.yaml`, no el source.

Los tres slots escriben con el mismo DSL que cualquier otro campo:
`$set:<campo>=<valor>`. `Labels` es el campo **multi-valor** del source, así
que su valor son operaciones con signo (`+añadir`, `-quitar`, `=` para
reemplazar el set completo) que el source resuelve contra las labels vigentes
— nunca pisa las que el agente no nombra.

| Paso | Label que dispara | Agente | Al empezar (`onProcess`) | Al terminar |
| --- | --- | --- | --- | --- |
| Refinar | `agent:refine` | `subscriptions-refiner` | saca `agent:refine` | `+agent:build` (éxito) / `+blocked` (error) |
| Implementar | `agent:build` | `subscriptions-implementer` | saca `agent:build`, `-ci-checked` | `+agent:review` (éxito, PR abierto) / `+blocked` (error) |
| Revisar CI | `agent:review` + `labels != ci-checked` | `subscriptions-ci-watcher` | saca `agent:review` | `+agent:review,+ci-checked` (CI verde) / `+agent:build` (CI rojo) |

Cada agente saca su propia label disparadora apenas empieza — así, mientras
corre, el issue queda visible en GitHub como "se lo llevaron, todavía no
volvió" y el daemon no lo re-toma en el próximo scan (esto es además de que
el flag `working` de la task ya bloquea el re-dispatch del mismo run).

**`subscriptions-ci-watcher` nunca mergea el PR** — cuando el CI está verde,
vuelve a poner `agent:review` junto con `ci-checked`, esperando que un humano
revise y mergee a mano (`when: labels != ci-checked` evita que se re-dispare
mientras esa combinación siga puesta). Si el CI da rojo, pone `agent:build`
en su lugar; el `onProcess` de `subscriptions-implementer` limpia `ci-checked`
al empezar ese nuevo ciclo, así el próximo paso por review vuelve a disparar
el watcher desde cero.

### Branch: la crea el engine, no el implementer

`subscriptions-implementer` tiene `requiresBranch: true` — el engine crea la
[linked branch de GitHub](../../packages/agent-engine/src/linked-branch.ts)
**antes** de correr el agente y la deja en `{{task.branch}}`. El prompt
pushea ahí directamente (no crea una branch nueva por su cuenta), así
`subscriptions-ci-watcher` puede encontrar el PR de forma determinística
buscando por head branch = `{{task.branch}}`.

## Setup en GitHub antes de correr esto contra el repo real

En `github.com/la-haus/subscriptions`, creá estas labels:

- `ia-flow` — la label **ancla** (`anchorLabel` en `projects.yaml`): decide
  qué issues entran al pipeline de ia-flow en general. Ponela en cada issue
  que querés que el engine tome.
- `agent:refine`, `agent:build`, `agent:review` — los 3 pasos del pipeline.
- `blocked` — cualquier agente falla (`fail_task`) y pone esta label; un
  humano revisa y se la saca a mano cuando está listo para reintentar (no
  hay agente automático que reaccione a `blocked`).
- `ci-checked` — la usa `subscriptions-ci-watcher` para marcar "ya revisé
  este PR y el CI está verde, no hace falta re-revisar".

Un issue nuevo entra al pipeline con `ia-flow` + `agent:refine` puestos a
mano (o vía automatización externa).

## URL del túnel + secret del webhook

Este deploy corre en modo `webhook` (default del daemon) y necesita una URL
pública para que GitHub le pueda hacer POST. El contenedor **no** abre ni
administra ningún túnel — `entrypoint.sh` arranca `apps/server` y, junto a
él, un proxy standalone (`scripts/webhook-proxy.ts`) que sólo reenvía
`POST /api/webhooks/github` (404 a todo lo demás) en el puerto `8787`,
mapeado a `127.0.0.1:8788` en el host (`docker-compose.yml`). El túnel
público se corre **a mano, en el host**, apuntando a ese puerto:

```bash
cloudflared tunnel --url http://localhost:8788   # o ngrok http 8788, etc.
```

Dejalo corriendo en un proceso persistente (tmux, una LaunchAgent) — sobrevive
a un `docker compose restart` del contenedor, porque vive completamente
afuera de él.

Al terminar de arrancar el contenedor, **mirá los logs** para el secret que
hay que pegar en GitHub:

```bash
docker compose logs -f subscriptions   # o: podman compose logs -f subscriptions
```

```
==================================================================
 GitHub webhook — Settings > Webhooks > Add webhook, en
 github.com/la-haus/subscriptions

   Content type: application/json
   Secret:       a1b2c3...
   Eventos:      Issues, Issue comment
==================================================================
```

- **Payload URL:** `<url-del-túnel>/api/webhooks/github` — depende del túnel
  que corras en el host, no de nada que imprima el contenedor.
- **Secret:** si no seteaste `IA_FLOW_WEBHOOK_SECRET` en `.env`,
  `entrypoint.sh` genera uno al primer boot y lo persiste en
  `/data/webhook-secret` (el volumen nombrado) — sobrevive a restarts del
  contenedor.
- El puerto `3001` (API completa, sin auth propia) **no** se publica al
  host — el único puerto mapeado es el `8787` interno (`8788` en el host)
  del proxy.

## Auth — CLAUDE_CODE_OAUTH_TOKEN + GITHUB_TOKEN

Igual que `implementer-accountant`: `buildAnthropicAuthHeader`
(`packages/ai-providers/src/anthropic-api/auth.ts`) prioriza
`CLAUDE_CODE_OAUTH_TOKEN` sobre `ANTHROPIC_API_KEY` cuando ambos están
seteados — generalo con `claude setup-token`.

`GITHUB_TOKEN` (Personal Access Token, classic o fine-grained) necesita
permisos de escritura sobre `la-haus/subscriptions`: `contents`
(crear branch + comitear), `pull_requests` (abrir PR + leer checks/CI), e
`issues` (leer/mover status vía label + comentar). Lo usan los 3 agentes
(vía el MCP de GitHub) y el source `github-issues` (leer/mover el issue) —
mismo token para todo.

## Run (docker-compose / podman-compose — recomendado)

```bash
cd agents/subscriptions-pipeline
cp subscriptions.env.example .env   # completar CLAUDE_CODE_OAUTH_TOKEN, GITHUB_TOKEN
docker compose up -d --build        # o: podman compose up -d --build
docker compose logs -f subscriptions
```

## Build/Run manual (sin compose)

```bash
# Desde la raíz del repo
podman build -t ia-flow-subscriptions-pipeline -f agents/subscriptions-pipeline/Dockerfile .

podman run -d --name ia-flow-subscriptions-pipeline \
  -p 127.0.0.1:8788:8787 \
  -v ia-flow-subscriptions-data:/data \
  -e CLAUDE_CODE_OAUTH_TOKEN=... \
  -e GITHUB_TOKEN=ghp_... \
  ia-flow-subscriptions-pipeline

podman logs -f ia-flow-subscriptions-pipeline   # ver el secret del webhook
```

Si preferís `polling` en vez de `webhook` para probar sin exponer nada a
internet, agregá `-e IA_FLOW_DAEMON_MODE=polling` — el proxy sigue
levantado igual, simplemente no hace falta un túnel apuntándole.

## Cambiar la config (roster, proyecto, repo, catálogo MCP)

Igual que en `implementer-accountant`: editar + reconstruir, o bind-mount en
runtime sobre `/app/config/<archivo>` (ver el `ENV IA_FLOW_*_FILE` del
Dockerfile y las líneas comentadas en `docker-compose.yml`).

## Logs

El contenedor siempre escribe su propio `daemon.log` bajo `/data/logs`
(`docker compose logs -f subscriptions` para verlo en vivo).

Para que esos mismos logs aparezcan en el `daemon.log`/UI del server
principal que corre en tu host (`bun run start` / `bun run dev:server`):

1. **En el host**, seteá un token antes de arrancar:
   ```bash
   IA_FLOW_REMOTE_LOG_TOKEN=algo-random bun run start
   ```
2. **En `.env`** de esta carpeta, el mismo token + la URL (ya vienen en
   `subscriptions.env.example`):
   ```bash
   IA_FLOW_REMOTE_LOG_URL=http://host.containers.internal:3001/api/remote-logs
   IA_FLOW_REMOTE_LOG_TOKEN=algo-random   # el MISMO valor del paso 1
   ```
   `host.containers.internal`, no `host.docker.internal`: Podman (gvproxy) lo
   resuelve de fábrica apuntando al host, sin `extra_hosts` ni el
   `--add-host ...:host-gateway` que en macOS tiene un bug conocido ("host
   containers internal IP address is empty") y bloquea el `up` entero. Con
   Docker Desktop, `host.docker.internal` + `extra_hosts` también funciona si
   preferís esa forma.
3. Reconstruí/reiniciá el container (`docker compose up -d --build`) para que
   tome las nuevas vars del `.env`.

Sin las dos vars del paso 2, el comportamiento es el de siempre: solo
archivo local, sin forward. El server principal necesita el mismo
`IA_FLOW_REMOTE_LOG_TOKEN` en su entorno o rechaza el POST con 503
(fail-closed, igual que `/api/webhooks/*`).

## Notas Podman

Es un Dockerfile OCI estándar — `docker build`/`docker run` funcionan igual.
En macOS con Podman, arrancá la VM primero: `podman machine start`.

## Limitaciones conocidas

- Ningún agente puede correr tests/lint localmente (sin `bash_run`) — la
  validación real la hace el CI del repo, y por eso existe el paso
  `subscriptions-ci-watcher`. El implementer debe ser conservador y preferir
  cambios chicos y verificables por lectura antes que cambios grandes que no
  puede probar él mismo.
- Un source `github-issues` está atado a un solo repo — si una tarea real
  cruza `subscriptions` con otro repo de La Haus, este roster no tiene forma
  de desglosarla; el refiner lo señala en "Riesgos y preguntas abiertas" pero
  no la parte solo.
