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
- **Las ejecuciones persisten en SQLite** (`bun:sqlite`, `.state/executions.sqlite`): una task
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

### Las actions (`actions/`)

Cada `*.ts` que está directo en una carpeta `actions/` exporta por default una definición (o una
lista) y se registra sola en su scope:

```ts
import { defineAction } from '@ia-flow/runner-v2/actions'
export default defineAction({ id: 'resolve_task', create: (ctx) => new ResolveTaskAction(…) })
```

`create` recibe quién la pide (`sourceId`, `agentId`, las `options` del YAML), el proyecto de esa
fuente, todos los proyectos y los servicios que monta el runner (GitHub, workspace, la credencial de git). Una
fuente de proyecto ve primero las suyas y después las globales; la global, sólo las globales. Un
id repetido en el mismo scope rompe el arranque. `defineMapper` registra un mapper de `onError`.

Las actions importan paquetes y el contrato del runner: la carpeta de la definición tiene que
vivir DENTRO de `apps/runner-v2` (así resuelven sus dependencias), también con `RUNNER_CONFIG_DIR`.

### Las pipelines (`pipelines/`)

Una por momento del flujo, no por variante: `refine`, `build-arrival`, `build-reentry`, `review`,
`e2e`, `ci-red`, `pr-changes-requested` y `comment`. Qué agente atiende lo decide el `when` de
cada paso — por tipo de task y por repo (frontend o el resto) —, y `firstMatch: true` corre sólo
el primero que pasa, así que el orden de los pasos es la prioridad. En `comment`, si el comentario
pide un cambio lo decide su `whenText` (la capacidad `whenText`: el agente `text-classifier`, Haiku). Un mismo agente no puede ser dos pasos de una
pipeline: por eso llegada y reentrada a Build, o CI rojo y cambios pedidos, son pipelines aparte.

### El intake

Un webhook entra al engine tal cual lo mandó GitHub (`github.<evento>`) y lo recibe el intake:
El intake (`intake`, inline en `sources.pipelines` de runner.yaml) es un solo paso, `resolve_task` (`actions/resolve_task.ts`). Es uno
para todos los proyectos: decide de cuál es el evento (el board del item, el catálogo de repos, la
card del issue y la label) y, por cada uno, encuentra la task
(el issue detrás de un item del board, el que implementa el PR de un comentario o de un CI), la
lee de GitHub —card, issue, blockers, timeline del issue y del PR, CI— y publica el evento de la
task con su scope. No publica nada para un repo fuera del catálogo, ni para una card de otro
board o sin la `label` del proyecto (`project.yaml`; hoy `blocked`): esas son del engine de
producción. El evento lleva `message`, el texto con el que le llega a un agente que ya corre. `intake-unblock` es el mismo paso con `unblockDependents: true`.

Lo que el YAML nombra y definen las `actions/`:

| Nombre | Qué es |
| --- | --- |
| `update_issue`, `post_comment` | transiciones del board y el comentario de cierre (firmado por el agente) |
| `post_notice` | un comentario sin firma de agente: el aviso del `onInterrupt` del proyecto (quién paró y en qué quedó) |
| `react_to_comment`, `review_pull_request`, `pr_checks`, `create_github_issue`, … | las tools de GitHub del proyecto |
| `fs_read`, `fs_list`, `fs_grep`, `fs_write`, `fs_edit`, `bash_run` | disco sobre el worktree de la task; `bash_run` con `options` (`allow`, `deny`, `githubAuth`, `timeout`, `maxTimeout`) |
| `issue_body` | las tools del body del issue que el agente puede tocar (`options: { write, check }`) |
| `blockedReport` | el reporte de una corrida que falló (el `onError` del proyecto) |
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
bun run host:serve                               # presta los providers locales a otros runners,
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
| `WORKSPACE_DIR` | dónde van clones y worktrees (default: `~/.cache/ia-flow/runner-v2/workspaces`) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | trazas y logs por OTLP — `bun run otel` levanta el Grafana local con los dashboards ([otel/](otel/README.md)) |
| `CLAUDE_CODE_OAUTH_TOKEN` | la credencial del provider `claude-cli` (el CLI `claude`) |
| `SLACK_BOT_TOKEN` | las actions de Slack y `request_slack_review` |
| `MEMORY_MCP_URL` | el MCP de memoria (`runner.yaml` lo nombra como `${MEMORY_MCP_URL}`) |
| `IA_FLOW_PROVIDER_HOST_TOKEN`, `IA_FLOW_PROVIDER_HOST_PORT` | `--host`: el bearer que se exige y el puerto (default 3002) |
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
dato: `.config/agents/assistant.yaml` y `.config/actions/assistant.ts` (las `assistant_*`: bandeja,
tarea, "¿por qué?", traza, config, eventos, estado, y `assistant_propose_action`, que propone y no
ejecuta). Cada pregunta abre una sesión con su contexto —todo el runner, un proyecto o una tarea—
que esas tools respetan (`src/assistant/AssistantSession.ts`). La respuesta es la que el agente
entrega en `submit_done` (`answer`, obligatoria), junto con las tareas de las que habla (`tasks`), que
la web muestra como cards. Sacar la línea de `sources.capabilities` lo apaga.

**Las conversaciones se guardan por login de GitHub** (`assistant_conversation` y
`assistant_message`, en la misma base): sólo cuando quien pregunta tiene sesión, cada una de UN
contexto, y cada login ve y borra sólo las suyas. Sin sesión el chat funciona igual, pero no queda.
La pregunta y su respuesta se guardan juntas y sólo si hubo respuesta.

## Providers en otra máquina (`type: remote` y `--host`)

Un runner puede correr un agente con el provider de OTRA máquina —una con el CLI `claude`
logueado, más RAM, otra red— sin que ese agente se entere: es el `RemoteAgentProvider` +
`agent-host` de v1 sobre el engine nuevo, en [`@ia-flow/provider-remote`](../../packages/providers/remote).

La máquina que presta levanta este mismo runner con `--host` y su propia `.config`. Un host no
despacha nada: monta sólo su identidad de GitHub (para clonar), su workspace (`WORKSPACE_DIR`) y
sus providers — ni engine, ni fuentes, ni base de ejecuciones, ni la marca Working. Su
`runner.yaml` alcanza con `github:`, `providers:` y `host:`:

```yaml
# runner.yaml de la máquina que presta
providers:
  claude-cli: { type: claude-cli, mode: print, maxConcurrent: 2 }
host:
  port: 3002
  providers: [claude-cli]          # default: todos los locales
  rules:                           # qué trabajo toma: todas tienen que pasar
    - { field: repo, op: matches, value: la-haus/* }
```

Y el runner que despacha la declara como un provider más; los agentes la nombran por su clave:

```yaml
# runner.yaml del runner que despacha
providers:
  gpu-box:
    type: remote
    url: http://gpu-box:3002
    token: ${IA_FLOW_REMOTE_GPU_BOX_TOKEN}   # el IA_FLOW_PROVIDER_HOST_TOKEN del otro lado
    provider: claude-cli                     # el id allá (default: esta misma clave)
    maxConcurrent: 2
```

Las tools del agente corren en el runner que despacha (vuelven por el mismo canal: el host no
se conecta de vuelta); el modelo y las tools nativas del CLI, en el host, sobre SU worktree. Las
tools de workspace del agente (`fs_*`, `bash_run`, …) no le llegan a un provider con workspace
nativo como el CLI, así que hay un solo checkout: el del host. Lo que el provider hace allá
(spans y logs) vuelve por el sync y el runner lo reexporta a su collector con los ids
originales: la corrida remota se ve entera en su Grafana, sin configurar OTLP en el host. El
detalle —pistas de admisión, silencio, huérfanas, límites— en el README del paquete.

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
  `runner.yaml`, `bun run memory-mcp`), no tools nativas.
- Los `settings` del runner v1 (`apps/server`) que este runner no implementa (API, websocket,
  polling): `runner.yaml` sólo acepta lo que se usa. Los remote providers sí se portaron
  (`type: remote` y `--host`, arriba), sin el registro dinámico de hosts ni su pantalla.
