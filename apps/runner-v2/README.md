# runner-v2

El runner headless de ia-flow sobre [`@ia-flow/agent-engine`](../../packages/agent-engine/core):
lee `.config/`, registra las actions de cada scope, monta el engine y levanta el servidor de
webhooks. No traduce ni arma eventos: eso lo hacen las pipelines y las actions de `.config/`. Es el `ai-development-flow` de los examples de ia-tools traído acá,
con la definición del pipeline como datos y las ejecuciones en SQLite.

## Qué cambia respecto del runner v1 (`apps/server`, ya purgado)

- **La definición vive en `.config/`**, en YAML (`@ia-flow/agent-engine-datasource-yaml` la traduce a
  definiciones y `@ia-flow/agent-engine-definitions` las arma)
  (agentes y pipelines del engine), y se recarga en caliente: editar un YAML aplica en el
  próximo evento, sin reiniciar. Una versión inválida se loguea y sigue la última buena.
- **Las ejecuciones persisten en SQLite** (`bun:sqlite`, `<IA_FLOW_HOME>/runner.sqlite`): una task
  nunca corre dos agentes a la vez, y una pausa —esperar el CI después de abrir el PR— sobrevive
  a un reinicio. Una corrida que el reinicio cortó queda `failed` (`interrupted`) y lo que no
  llegó a leer se vuelve a despachar.

## `.config/`

`runner.yaml` es el índice: nada se descubre por carpeta, cada cosa se declara. Un archivo por
scope — lo global en `runner.yaml`, lo de un proyecto en su `project.yaml`.

```yaml
# runner.yaml
engine: { … }                       # CÓMO corre: store de ejecuciones, tick, formatMessage, interrupt
sources:                            # QUÉ corre: la composición del runner
  pipelines: [ … ]                  # la fuente global: el intake, inline
  agents: ./agents                  # sus agentes: los que cumplen capacidades
  capabilities:                     # lo que el engine le pide a un modelo (whenText, fileFocus)
    whenText: { agent: text-classifier }
  actions: ./actions                # actions globales
  projects:
    lahaus-ai-flow: ./projects/lahaus-ai-flow/project.yaml   # o el proyecto inline

# projects/lahaus-ai-flow/project.yaml
board: https://github.com/orgs/la-haus/projects/119
branchPrefix: ia-flow-local/
label: blocked
systemPrompts: [ … ]                # los defaults de su fuente (antes source.yaml)
onError: { … }
onInterrupt: { … }                  # qué queda si una regla corta a un agente (el comentario)
agents: ./agents
pipelines: ./pipelines
actions: ./actions
repos: ./repos
```

`agents`, `pipelines` y `repos` aceptan, solos o en lista, un directorio (sus `*.yaml` en orden de
nombre), un archivo, un glob en el nombre del archivo (`./pipelines/1*.yaml`) o el documento
inline; `actions` (código) sólo rutas — un directorio toma sus `*.ts` directos (no `_lib/`, ni
tests). Las rutas son relativas al archivo que las declara, y una que no existe rompe el arranque.
Editar `runner.yaml` o un `project.yaml` recarga sus fuentes (agentes y pipelines) sin reiniciar;
lo demás (board, label, actions, repos) se lee al arrancar.

El engine no sabe de proyectos: ve fuentes. El proyecto es una capa del runner que sólo filtra:
al montar un proyecto, el runner le pone `scope.projectId: <id>` a cada una de sus pipelines
(una propiedad más de la definición, `src/projects/withScope.ts`), así sólo corren con los eventos
de ese proyecto —los que publica `resolve_task`—; la global recibe todo. El engine lo arma el
runner desde `engine:` de runner.yaml (`src/engine/mountEngine.ts`).

### Las actions

Las estándar vienen con el runner (`src/actions/builtin/`): las transiciones y tools de GitHub
(`@ia-flow/github-tools`), Slack, el workspace, el intake y el asistente. Una config sólo trae las
suyas: cada `*.ts` que está directo en una carpeta `actions/` exporta por default una definición
(o una lista) y se registra sola en su scope:

```ts
import { defineAction } from '@ia-flow/runner-v2/actions'
export default defineAction({ id: 'resolve_task', create: (ctx) => new ResolveTaskAction(…) })
```

`create` recibe quién la pide (`sourceId`, `agentId`, las `options` del YAML), el proyecto de esa
fuente, todos los proyectos y los servicios que monta el runner (GitHub, workspace, la credencial de git). Una
fuente de proyecto ve primero las suyas y después las globales; la global, sólo las globales. Un
id repetido en el mismo scope rompe el arranque. `defineMapper` registra un mapper de `onError`.

Las actions importan paquetes (`@ia-flow/*`, `zod`) y el contrato del runner; el runner se los
sirve como módulos virtuales (`src/bundle/`), así que la carpeta de la definición puede vivir en
cualquier lado (`RUNNER_CONFIG_DIR` o `--config`): en el bundle, en los tests (el tmp del sistema)
y en un deploy.

### Las pipelines (`pipelines/`)

Una por momento del flujo, no por variante: `refine`, `build-arrival`, `build-reentry`, `review`,
`e2e`, `ci-red`, `pr-changes-requested` y `comment`. Qué agente atiende lo decide el `when` de
cada paso — por tipo de task y por repo (frontend o el resto) —, y `firstMatch: true` corre sólo
el primero que pasa, así que el orden de los pasos es la prioridad. En `comment`, si el comentario
pide un cambio lo decide su `whenText` (la capacidad `whenText`: el agente `text-classifier`, Haiku). Un mismo agente no puede ser dos pasos de una
pipeline: por eso llegada y reentrada a Build, o CI rojo y cambios pedidos, son pipelines aparte.

### El intake

Un webhook entra al engine tal cual lo mandó GitHub (`github.<evento>`) y lo recibe el intake:
El intake (`intake`, inline en `sources.pipelines` de runner.yaml) es un solo paso, `resolve_task` (`src/intake/`). Es uno
para todos los proyectos: decide de cuál es el evento (el board del item, el catálogo de repos, la
card del issue y la label) y, por cada uno, encuentra la task
(el issue detrás de un item del board, el que implementa el PR de un comentario o de un CI), la
lee de GitHub —card, issue, blockers, timeline del issue y del PR, CI— y publica el evento de la
task con su scope. No publica nada para un repo fuera del catálogo, ni para una card de otro
board o sin la `label` del proyecto (`project.yaml`; hoy `blocked`): esas son del engine de
producción. El evento lleva `message`, el texto con el que le llega a un agente que ya corre. `intake-unblock` es el mismo paso con `unblockDependents: true`.

Lo que el YAML nombra (del runner, salvo las marcadas como del proyecto):

| Nombre | Qué es |
| --- | --- |
| `update_issue`, `post_comment` | transiciones del board y el comentario de cierre (firmado por el agente) |
| `post_notice` | un comentario sin firma de agente: el aviso del `onInterrupt` del proyecto (quién paró y en qué quedó) |
| `react_to_comment`, `review_pull_request`, `pr_checks`, `create_github_issue`, … | las tools de GitHub del proyecto |
| `fs_read`, `fs_list`, `fs_grep`, `fs_write`, `fs_edit`, `bash_run` | disco sobre el worktree de la task; `bash_run` con `options` (`allow`, `deny`, `githubAuth`, `timeout`, `maxTimeout`) |
| `issue_body` | del proyecto: las tools del body del issue que el agente puede tocar (`options: { write, check }`) |
| `blockedReport` | del proyecto: el reporte de una corrida que falló (el `onError` del proyecto) |
| `resolve_task` | el intake: de un webhook crudo al evento de su task (`unblockDependents` para el unblock) |

## Correr

Los paquetes del engine (`@ia-flow/agent-engine`, `@ia-flow/github-*`, `@ia-flow/workspace`, …)
son workspaces de este repo, source-only: se consumen con `workspace:*` y no hay nada que
compilar ni linkear.

```bash
bun install                                       # desde la raíz del repo

cd apps/runner-v2
bun run start                                     # verifica GitHub, carga y valida la definición
bun run src/main.ts --event github.issue_comment ./delivery.json   # un webhook crudo, por el intake
bun run src/main.ts --replay-pr la-haus/subscriptions#45           # un PR real, como `opened`
IA_FLOW_WEBHOOK_SECRET=... bun run serve         # servidor de webhooks
bun run host:serve                               # le presta su CLI `claude` a un runner (se suscribe),
                                                 # con su propio .env.host (ver .env.host.example)
bun test
bun run typecheck
```

Bun carga el `.env` del directorio desde el que corre (gitignoreado). `.env.example` las trae
todas, comentadas: copialo a `.env`. Las principales:

| Variable | Para qué |
| --- | --- |
| `IA_FLOW_GITHUB_APP_PRIVATE_KEY_PATH` | pisa `github.privateKeyPath` de `runner.yaml` (ahí, relativa al archivo): el PEM de la GitHub App |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | el provider `anthropic-api` |
| `IA_FLOW_WEBHOOK_SECRET` | el HMAC de los webhooks (sin él, todo POST responde 503) |
| `FIGMA_MCP_TOKEN` | el token del MCP de Figma (`runner.yaml` lo nombra como `${FIGMA_MCP_TOKEN}`) |
| `RUNNER_CONFIG_DIR` | otra carpeta de definición (default: `.config`) |
| `IA_FLOW_HOME` | el estado de esta máquina, fuera del repo: `runner.sqlite`, `workspaces/`, `memory.json` (default: `~/.local/state/ia-flow/runner`) |
| `WORKSPACE_DIR` | dónde van clones y worktrees (default: `<IA_FLOW_HOME>/workspaces`) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | trazas y logs por OTLP — `bun run otel` levanta el Grafana local con los dashboards ([otel/](otel/README.md)) |
| `LOG_LEVEL` | nivel mínimo de los logs (pisa `settings.telemetry.logLevel` de `runner.yaml`): `debug`, `info` (default), `warn`, `error`. En `debug` el provider `anthropic-api` vuelca cada request y respuesta de la API, con las credenciales tapadas |
| `CLAUDE_CODE_OAUTH_TOKEN` | la credencial del provider `claude-cli` (el CLI `claude`) |
| `SLACK_BOT_TOKEN` | las actions de Slack y `request_slack_review` |
| `MEMORY_MCP_URL` | el MCP de memoria (`runner.yaml` lo nombra como `${MEMORY_MCP_URL}`) |
| `IA_FLOW_HOST_TOKEN` | el token de hosts: el runner lo exige a los que se suscriben, y el host lo presenta |
| `IA_FLOW_HOST_NAME`, `IA_FLOW_HOST_RUNNER_URL` | `--host`: pisan `host.name` y `host.runner` |
| `IA_FLOW_API_TOKEN` | el token de la API de la web (`x-ia-flow-token`); sin él, la API responde 503 |
| `IA_FLOW_GITHUB_CLIENT_ID` | (o `github.clientId`) el client id de la GitHub App: el login de cada persona en la web |

## La bandeja, el asistente y lo que pasó (`--serve`)

En el mismo puerto que los webhooks, `--serve` expone la API de la web (contrato:
`packages/shared/src/inbox.ts`). Todo pide `IA_FLOW_API_TOKEN` en `x-ia-flow-token` (o
`Authorization: Bearer`, o `?token=` para el stream) y responde CORS al origen que pregunte.

| Ruta | Qué |
| --- | --- |
| `GET /api/runner` | quién es (el selector de servidores de la web lo reconoce por acá) |
| `GET /api/inbox?project=` | la bandeja: **te necesita**, **falló**, **corriendo**, **en cola** (`inbox/classify.ts`) |
| `GET /api/tasks/:owner/:repo/:n` | una tarea: sus ejecuciones, los eventos con qué decidió cada pipeline, y la traza |
| `GET /api/explain?ref=&event=` | "¿por qué corrió / no corrió?": el mismo plan del engine, en seco |
| `GET /api/config` | la config cargada, en corto |
| `GET /api/stream` | SSE: qué cambió (una tarea, una traza, un evento) |
| `POST /api/tasks/:owner/:repo/:n/actions` | mergear, aprobar el PRD, devolver, contestar y destrabar, relanzar, reintentar, re-ejecutar el review (simula que la card llegó a Review), pedir que pare — con el token de GitHub de quien lo hace (`x-github-token`): el movimiento queda a su nombre |
| `POST /api/auth/github/device` (+ `/poll`) | el login de GitHub de la web (device flow de la App); el runner no guarda el token |
| `POST /api/assistant` | el asistente (SSE): la capacidad `assistant` (ver abajo). Con `x-github-token`, el intercambio se guarda a nombre de ese login |
| `GET /api/assistant/conversations?scope=` | las conversaciones guardadas de quien pide (`x-github-token`), del contexto `scope` (un `AssistantScope` en JSON) |
| `GET` / `DELETE /api/assistant/conversations/:id` | una conversación guardada (sus tareas, como están ahora en la bandeja) / borrarla. La de otro login no existe: 404 |

**Lo que pasó queda en SQLite**, en el mismo archivo que las ejecuciones (`engine.executions.path`):
`event_log` (cada evento, qué decidió cada pipeline y por qué) y `execution_trace` (cada span y
log de cada ejecución, en el momento: tools, mensajes del modelo con sus tokens, hooks del CLI,
lo que vuelve de un host remoto). Es lo mismo que sale por OTLP, emitido una sola vez: la
telemetría se registra siempre y OTLP es un destino más cuando hay endpoint. Se borra lo que tiene
más de `inbox.retentionDays`.

```yaml
# runner.yaml — todo opcional, estos son los defaults
inbox:
  labels: { blocked: blocked, reviewed: reviewed }
  statuses: { refine: Refine, refined: Refined, build: Build, review: Review }
  staleHours: 24        # "sin movimiento"
  retentionDays: 14
  conversationRetentionDays: 90   # una conversación del asistente sin tocar
  commentExcerpt: 140   # cuánto de un comentario queda en el resumen del evento
  mergeMethod: squash
```

**El asistente es un agente más**, enchufado a la capacidad `assistant` de la fuente global
(`sources.capabilities.assistant: { agent: assistant }`). Su modelo, su prompt y sus tools son
dato: `.config/agents/assistant.yaml` y `src/actions/builtin/assistant.ts` (las `assistant_*`: bandeja,
tarea, "¿por qué?", traza, config, eventos, estado, y `assistant_propose_action`, que propone y no
ejecuta). Cada pregunta abre una sesión con su contexto —todo el runner, un proyecto o una tarea—
que esas tools respetan (`src/assistant/AssistantSession.ts`). La respuesta es la que el agente
entrega en `submit_done` (`answer`, obligatoria), junto con las tareas de las que habla (`tasks`), que
la web muestra como cards. Sacar la línea de `sources.capabilities` lo apaga.

**Las conversaciones se guardan por login de GitHub** (`assistant_conversation` y
`assistant_message`, en la misma base): sólo cuando quien pregunta tiene sesión, cada una de UN
contexto, y cada login ve y borra sólo las suyas. Sin sesión el chat funciona igual, pero no queda.
La pregunta y su respuesta se guardan juntas y sólo si hubo respuesta.

## Providers en otra máquina (`--host` y `remote:*`)

Un runner puede correr un agente en OTRA máquina —una con el CLI `claude` logueado, más RAM, otra
red— como si fuera un CLI local, pero contra una API: el host se suscribe al runner y pide tareas;
el runner le entrega cada corrida y la espera. Es el `agent-host` de v1 sobre el engine nuevo, en
[`@ia-flow/provider-remote`](../../packages/providers/remote) (ahí, el detalle).

**El host** es este mismo runner con `--host` (`bun run host:serve`, con su `.env.host`) y su propia
`.config`. No despacha nada: monta su identidad de GitHub (para clonar), su workspace
(`WORKSPACE_DIR`) y el CLI que presta — ni engine, ni fuentes, ni base de ejecuciones, ni servidor.
Todas las conexiones salen de él: no necesita URL pública.

```yaml
# runner.yaml de la máquina que presta
github: { … }                              # para clonar
providers:
  claude-tmux: { type: claude-cli, mode: tmux, timeoutMinutes: 120 }
host:
  name: julian-laptop                      # → remote:julian-laptop (env: IA_FLOW_HOST_NAME)
  runner: https://ia-flow.example.com      # la base del runner (env: IA_FLOW_HOST_RUNNER_URL)
  provider: claude-tmux                    # default: la única entrada claude-cli
  maxConcurrent: 1
  accepts:                                 # qué toma: como el `when` de las pipelines
    - { field: repo, op: in, value: [ subscriptions, eks ] }
    - { field: agentId, op: neq, value: reviewer }
```

**El runner** no declara hosts: con `IA_FLOW_HOST_TOKEN` en su ambiente (el mismo que presenta el
host), `--serve` monta la API de hosts en el puerto de los webhooks (`/v1/hosts/*`, `/v1/runs/*`) y
cada host que se suscribe aparece como `remote:<name>`. Los agentes lo nombran, o usan el comodín:

```yaml
providers:
  - id: remote:*            # cualquier host suscrito que lo acepte, en orden de suscripción
    config: { model: opus }
  - id: claude-tmux         # el respaldo si no hay ninguno (sin respaldo, espera a que llegue uno)
```

El canal de la corrida es el mismo que el del CLI local, montado en la API del runner: las tools del
agente (su MCP), los hooks (la traza de las tools nativas, el inbox, no terminar sin cerrar el turno)
y el cierre cuando el modelo llama `submit_*`. El uso de cada request al modelo sale de la
transcripción de la sesión, que `claude` escribe en el disco del host: el host la sigue y la manda
por `POST /v1/runs/<token>/transcript`, y el runner la registra como spans `chat <model>` (los
tokens del dashboard). El host sólo lanza `claude` en SU worktree apuntando
ahí, y lo corta cuando el runner cierra la corrida. Un solo checkout, el del host: las tools de
workspace del agente no le llegan, y el `git push` sale con las credenciales de esa máquina.

**La telemetría del host es la del runner.** Sin `OTEL_EXPORTER_OTLP_ENDPOINT`, el host exporta
sus trazas y logs en OTLP/HTTP JSON estándar al runner (`/v1/hosts/telemetry/*`, con el token de
hosts); el runner los anota en su base (la bandeja los muestra con el nombre del host) y los
reexporta a su collector con sus `OTEL_EXPORTER_OTLP_HEADERS`. Cada tarea lleva el contexto de traza
del agente, así que el worktree, la sesión y los logs del host quedan en la misma traza y la misma
ejecución (`host.run <agente>`). Al host sólo le hace falta `logLevel`. Si no llega al runner,
queda su consola; con `OTEL_EXPORTER_OTLP_ENDPOINT` propio, exporta directo a ese collector.

Un `--event` también monta la API de hosts (con `IA_FLOW_HOST_TOKEN`), así un evento suelto puede
correr un agente `remote:*` — para probar un host sin levantar `--serve`.

## MCP propios (`mcpHost:`)

A los MCP de `mcp:` los llama Anthropic (van en `mcp_servers` de la Messages API), así que tienen
que ser públicos. Los que no son de un tercero —Figma (`figma-developer-mcp`), la memoria de los
agentes (`server-memory`)— los levanta el runner con `--serve` y los publica en `/mcp/<id>` de su
mismo puerto, con un bearer propio por entrada (esos procesos no autentican nada):

```yaml
mcpHost:
  figma:
    command: [figma-developer-mcp, --port, '3333', --host, 127.0.0.1, --skip-image-downloads, --no-telemetry]
    upstream: http://127.0.0.1:3333/mcp
    token: ${FIGMA_MCP_TOKEN}          # sin resolver: no se levanta y /mcp/figma responde 503
  memory:
    command: [supergateway, --stdio, mcp-server-memory, --outputTransport, streamableHttp,
              --streamableHttpPath, /mcp, --port, '8931']
    upstream: http://127.0.0.1:8931/mcp
    token: ${MEMORY_MCP_TOKEN}
    env: { MEMORY_FILE_PATH: /state/memory.json }

mcp:
  - id: memory-mcp
    config:
      type: http
      url: https://<runner público>/mcp/memory
      authorizationToken: ${MEMORY_MCP_TOKEN}
      hosted: memory                   # se prueba contra su proceso, no contra la URL pública
```

Cada proceso se relanza si se cae; cinco caídas de menos de 10 s seguidas y queda caído (el
agente que lo nombra corre sin él, los webhooks siguen). `bun run memory-mcp` sigue sirviendo
para correrlo aparte, en local, detrás de un túnel.

## El bundle publicado (`ia-flow-runner.js`)

Cada release adjunta el runner como un solo archivo (`bun run release:package`,
`scripts/package-release.ts`), construido y probado con Bun **1.4.2**. La config no va adentro:
la trae cada deploy (`RUNNER_CONFIG_DIR` o `--config`), en cualquier carpeta. Sus actions
importan `@ia-flow/*` y `zod`, y el bundle se los sirve como módulos virtuales
(`src/bundle/modules.ts`) — con las mismas instancias que usa el runner. Un paquete que no esté en
esa lista rompe el arranque del deploy; `dist-modules.test.ts` lo avisa antes contra esta `.config`.

`GET /health` contesta 200 mientras el proceso vive: es la probe de k8s y del balanceador.

## Tareas bloqueadas por otras (`mark_blocked_by`)

Una card con prerrequisitos abiertos no corre sus agentes (las pipelines filtran
`item.blocked`, salvo las de agentes que admiten correr bloqueados, como los refiners técnicos).
Cuando se mergea el PR del último prerrequisito, el intake (`intake-unblock`) busca en
GitHub los issues que ése bloqueaba (`dependencies/blocking`) y emite `issue.unblocked` para cada
uno que quedó sin bloqueadores abiertos. Las pipelines de
reentrada de cada columna lo escuchan, así que la card vuelve al agente que le toca donde esté.
Es el `unblock-dependents-on-merge` del runner v1, pero para PRs de cualquier repo del
catálogo, no sólo de `claw-agents`.

## Lo que no se portó del ejemplo

- Las tools `memory_*` del implementer: la memoria es el MCP oficial (`memory-mcp` en
  `runner.yaml`: en un deploy, `mcpHost.memory`; en local, `bun run memory-mcp`), no tools
  nativas.
- Los `settings` del runner v1 (`apps/server`) que este runner no implementa (API, websocket,
  polling): `runner.yaml` sólo acepta lo que se usa. Los hosts remotos sí se portaron (`--host` y
  `remote:*`, arriba): se suscriben solos, sin la pantalla de v1.
