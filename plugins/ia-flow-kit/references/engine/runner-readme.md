<!-- GENERADO por scripts/sync-plugin-docs.ts desde apps/runner-v2/README.md. No editar: cambiá la fuente y corré `bun run plugin:sync`. -->

# runner-v2

El runner headless de ia-flow sobre [`@ia-flow/agent-engine`](../../packages/agent-engine/core):
lee `.config/`, registra las actions de cada scope, monta el engine y levanta el servidor de
webhooks. No traduce ni arma eventos: eso lo hacen las pipelines y las actions de `.config/`. Es el `ai-development-flow` de los examples de ia-tools traído acá,
con la definición del pipeline como datos y las ejecuciones en SQLite.

## Cómo funciona

- **La definición es un `runner.yaml`** (`--config <archivo|carpeta>`, `RUNNER_CONFIG`, o `.config/`
  local —no versionada—), en YAML (`@ia-flow/agent-engine-datasource-yaml` la traduce a
  definiciones y `@ia-flow/agent-engine-definitions` las arma)
  (agentes y pipelines del engine), y se recarga en caliente: editar un YAML aplica en el
  próximo evento, sin reiniciar. Una versión inválida se loguea y sigue la última buena.
- **Las ejecuciones persisten en SQLite** (`bun:sqlite`, `<IA_FLOW_HOME>/runner.sqlite`): una task
  nunca corre dos agentes a la vez, y una pausa —esperar el CI después de abrir el PR— sobrevive
  a un reinicio. Una corrida que el reinicio cortó queda `failed` (`interrupted`) y lo que no
  llegó a leer se vuelve a despachar.

## La config (`--config`)

`--config` (o `RUNNER_CONFIG`) es el `runner.yaml` a correr, o una carpeta (su `runner.yaml`); sus
rutas relativas se resuelven contra la carpeta del archivo. La de producción de La Haus vive en
`la-haus/claw-agents` → `agents/ai-development-flow/config/`. Para correr en local, un
`runner.local.yaml` junto a ella (gitignoreado) reusa sus agentes, pipelines y repos con las mismas
rutas y cambia lo de la máquina:

```bash
# apps/runner-v2/.env
RUNNER_CONFIG=~/…/claw-agents/agents/ai-development-flow/config/runner.local.yaml
```

y `bun run runner:serve` como siempre.

Un `runner.yaml` no incluye a otro: lo inline (el intake, las capacidades, y del proyecto los
`systemPrompts`, `onError`, `onInterrupt`) va copiado en el `.local`.

`runner.yaml` es el índice: nada se descubre por carpeta, cada cosa se declara. Un archivo por
scope — lo global en `runner.yaml`, lo de un proyecto en su `project.yaml`.

```yaml
# runner.yaml
engine: { … }                       # CÓMO corre: store de ejecuciones, tick, formatMessage, interrupt
sources:                            # QUÉ corre: la composición del runner
  pipelines: [ … ]                  # la fuente global: el intake, inline
  agents: ./agents                  # agentes globales propios (opcional)
  capabilities:                     # opcional: pisar una capacidad del runner con un agente propio
    whenText: { agent: my-classifier }
  actions: ./actions                # actions globales
  projects:
    lahaus-ai-flow: ./projects/lahaus-ai-flow/project.yaml   # o el proyecto inline

# projects/lahaus-ai-flow/project.yaml
board: https://github.com/orgs/la-haus/projects/119
branchPrefix: ia-flow-local/
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
(una propiedad más de la definición, `src/engine/withScope.ts`), así sólo corren con los eventos
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
cualquier lado (`--config` o `RUNNER_CONFIG`): en el bundle, en los tests (el tmp del sistema)
y en un deploy.

### El board (`board:` de `project.yaml`)

El board de un proyecto es dónde vive el estado de sus tasks —la columna, el tipo, la marca "en
curso"— y cómo se entera el runner de que cambió. Lo elige `project.yaml`; el engine no sabe que
existe (ve `item.status`, `item.labels`… ya armados por el intake), y la bandeja, el intake y las
acciones sólo hablan con la interfaz `Board` (`src/board/`).

| `board:` | Qué es | El estado vive en |
| --- | --- | --- |
| `https://github.com/orgs/<org>/projects/<n>` | Project v2 de una organización | el campo `Status` de la card; GitHub avisa cada cambio (`projects_v2_item` → `issue.status_changed`) |
| `https://github.com/users/<login>/projects/<n>` | Project v2 de una cuenta personal | igual, pero GitHub **no** emite `projects_v2_item` para un Project personal: un cambio de columna no llega, y el token de una GitHub App no ve el Project (hace falta un token de usuario: `gh-cli`) |
| `{ kind: issues }` | los issues de los repos de `repos/` | labels del propio issue (`status:build`) |

```yaml
# un board de issues: no hay Project, sirve el token de una GitHub App
board:
  kind: issues
  statuses: [Todo, Refine, Build, Tests, Done]   # obligatorio: las columnas, en orden de avance
  statusPrefix: "status:"                        # opcional (es el default)
repos: ./repos                                   # cada repo con githubOwner y githubRepo
```

Con `kind: issues`:
- **Un issue está en el board por existir**: no hay "agregarlo" (`add_to_project` no hace nada) y el
  intake ya no descarta tasks por "no está en el board".
- **Mover una columna es cambiar un label.** Se agrega el nuevo antes de sacar el viejo, así la card
  nunca queda sin columna; con dos a la vez (un cambio a medias) vale la más avanzada de `statuses`.
  Si sacar el viejo falla se reintenta una vez y, si sigue fallando, se deshace. Por eso `statuses` es
  obligatorio: un label guarda `In Progress` como `status:in-progress`, y sólo la lista sabe cómo se
  escribe y en qué orden va.
  Los demás campos siguen el mismo esquema: `Task Type` = `task-type:<valor>`, la marca `Working` =
  `working:yes`.
- **Un label `status:*` puesto llega como `issue.status_changed`** (con la columna en `to`), igual
  que en un Project v2: las pipelines por columna sirven para los dos. `from` es la columna anterior
  cuando todavía está en el issue (siempre que mueve el runner; si una persona la sacó antes de poner
  la nueva, no se dice). Sacarlo no dispara nada (el
  nuevo llega por su propio webhook). Cualquier otro label sigue siendo `issue.labeled`. Hace falta
  el webhook `issues` en la App o el repo.
- **`item.labels` incluye los labels de campo** (`status:build`, `working:yes`): un `when` sobre
  `item.labels` los ve.
- La web identifica el board como `{ owner, number: 0 }` y su link es la página de issues del
  repo.

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
card del issue y el `when` del intake) y, por cada uno, encuentra la task
(el issue detrás de un item del board, el que implementa el PR de un comentario o de un CI), la
lee de GitHub —card, issue, blockers, timeline del issue y del PR, CI— y publica el evento de la
task con su scope. No publica nada para un repo fuera del catálogo, ni para una card de otro
board, ni para una task que no cumple el `when` del intake. El evento lleva `message`, el texto
con el que le llega a un agente que ya corre. `intake-unblock` es el mismo paso con
`unblockDependents: true`.

**Qué tasks toma este runner: `with.when` de `resolve_task`.** Filas como el `when` de una
pipeline (se combinan de izquierda a derecha), contra el evento de la task ya armado (`item.labels`,
`item.status`, `item.type`, `task.*`). Una task que no cumple no publica nada: ni las pipelines, ni
los `injects` de un agente que ya corre, ni una interrupción la ven. Se evalúa antes de proponer la
rama, así una card descartada no llama al `branch-namer`.

```yaml
- id: intake
  on: [ github.projects_v2_item, github.issue_comment, … ]
  do:
    - action: resolve_task
      with:
        when:
          - { field: item.labels, op: notContains, value: blocked }   # producción
          # - { field: item.labels, op: contains, value: blocked }    # un runner local que convive
```

Si `intake-unblock` tiene que respetar la misma regla, se repite en su paso (o con un ancla YAML).

**Qué cards muestra la bandeja: el `when` del proyecto** (`project.yaml`). Las mismas filas, sólo
sobre la card (`item.labels`, `item.status`, `item.type`, `item.repos`, `item.blocked`); sin él,
todas las cards del board. Es independiente del intake: cada uno filtra lo suyo.

```yaml
# project.yaml
when:
  - { field: item.labels, op: contains, value: blocked }
```

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
| `RUNNER_CONFIG` | el `runner.yaml` a correr, o su carpeta (default: `.config`, local y no versionada; alias `RUNNER_CONFIG_DIR`) |
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

**El asistente es un agente más**, el de la capacidad `assistant`, y viene con el runner
(`src/capabilities/assistant.yaml`): su prompt describe las tools del runner y lo que pinta la web,
así que cambia con ellos, en este repo. Sus tools son `src/actions/builtin/assistant.ts` (las `assistant_*`: bandeja,
tarea, "¿por qué?", traza, config, eventos, estado, y `assistant_propose_action`, que propone y no
ejecuta). Cada pregunta abre una sesión con su contexto —todo el runner, un proyecto o una tarea—
que esas tools respetan (`src/assistant/AssistantSession.ts`). La respuesta es la que el agente
entrega en `submit_done` (`answer`, obligatoria), junto con las tareas de las que habla (`tasks`), que
la web muestra como cards. Lee GitHub con `github-mcp-readonly` si el deploy lo declara en su `mcp`;
si no, corre sin él.

**El asistente puede tener varios agentes**: cada capacidad `assistant.<id>` es otro, con el mismo
contrato, y la web deja elegir con cuál hablar (`GET /api/runner` → `assistant_agents`; el pedido
lleva `agent`). Su entrada en `sources.capabilities` lleva además `label` y `description` para el
selector, que el runner saca antes de dársela al engine. Una conversación es de un contexto y de un
agente. El runner trae `assistant.runner-improvements` (`src/capabilities/runner-improvements.yaml`):
lee ejecuciones y trazas buscando fallas del proceso y, con `assistant_propose_issue` (el repo lo
fija su YAML con `with: { repo: julianjab/ia-flow }`), propone abrir un issue en ia-flow; la persona
lo confirma en la web y `POST /api/issues` lo abre con SU token de GitHub.

```yaml
sources:
  capabilities:
    assistant.costos: { agent: costos, label: Costos, description: Qué gastó cada agente }
```

**Las capacidades vienen con el runner** (`src/capabilities/`): `assistant`,
`assistant.runner-improvements`, `whenText`
(`text-classifier`), `fileFocus` (`file-focus`) y `branchName` (`branch-namer`), cada una con su
agente embebido en el runner (y en el bundle). Un deploy no declara nada para tenerlas; para cambiar
una, la pisa en `sources.capabilities` con un agente propio en `sources.agents` —con otro id: un
agente propio con el id de uno del runner rompe el arranque—.

**Los system prompts compartidos los define la config**, en `systemPrompts` de `runner.yaml`
(`[{ id: reglas, text: … }]`): cualquier agente los nombra por id en vez de copiarlos
(`systemPrompts: [{ id: reglas }, { text: … }]`). Un `{ id }` se resuelve contra los
`systemPrompts` de la fuente del agente (con ese `id`) o contra este catálogo; uno que no existe se
omite con un aviso al cargar (como un MCP que no está) y el agente corre sin ese bloque.

**Lo que un provider exige en todo request va en el provider**, no en los agentes: los
`systemPrompts` de `providers.anthropic-api` van antes de los de cada agente que corre ahí —las
capacidades del runner incluidas—, y no llegan a los que corren en otro provider (el CLI ya trae
su identidad):

```yaml
providers:
  anthropic-api:
    systemPrompts: ["You are Claude Code, Anthropic's official CLI for Claude."]
```

El `providerConfig.systemPrompts` de un agente los reemplaza enteros.

**Las conversaciones se guardan por login de GitHub** (`assistant_conversation` y
`assistant_message`, en la misma base): sólo cuando quien pregunta tiene sesión, cada una de UN
contexto, y cada login ve y borra sólo las suyas. Sin sesión el chat funciona igual, pero no queda.
La pregunta y su respuesta se guardan juntas y sólo si hubo respuesta.

### Las acciones de una tarea (`taskActions:` de `project.yaml`)

Lo que una persona puede pedirle a una tarea desde la bandeja o el asistente: cada acción es una
**cadena de actions del catálogo** —las mismas que usa un pipeline— con una guarda de cuándo
aplica. Se corren con el token de la persona que las pide (queda a su nombre y con sus permisos),
fuera de los pipelines: un rechazo no pasa por `onError`, así que no deja la tarea `blocked`.

```yaml
taskActions:
  answer_and_unblock:
    label: Responder y destrabar            # el botón
    available:                              # cuándo se ofrece: filas como el `when` de un pipeline
      - { field: run.exit, op: in, value: [ doubt, prerequisite ] }   #   sobre `item.*` (la card)
      - { field: run.failure_by, op: eq, value: agent, logic: or }    #   y `run.*` (su última corrida:
      - { field: item.labels, op: contains, value: blocked, logic: and } # exit, status, failure_by, agent)
    input: { comment: required }            # lo que pide a la persona (hoy, un comentario)
    confirm: ¿Publicar tu respuesta y devolverla a su etapa?
    steps:                                  # en orden; `when` por paso es opcional
      - { action: post_user_comment, with: { body: '{{input.comment}}' } }
      - { action: update_issue, with: { removeLabels: [ blocked ] } }
      - { action: update_issue, with: { status: '{{task.resume_stage}}' } }
```

- **Mandan sobre las del runner.** Una acción declarada con el mismo id que una de las del runner
  (`merge`, `approve_prd`, `answer_and_unblock`…) la reemplaza, y su `available` decide cuándo se
  ofrece. Las que un proyecto no declara siguen como antes: sin `taskActions`, nada cambia.
- **El `with` de un paso** se resuelve contra `input.comment`, `task.resume_stage` (la columna de la
  ejecución que falló), `item.*`, `run.*` y `actor` (el login).
- **El orden de los pasos es parte del diseño: no hay rollback.** Si un paso falla se corta y el
  error dice cuántos ya corrieron. En el ejemplo, el comentario va primero (el intake descarta los
  eventos de un issue `blocked`, así no dispara además el pipeline de comentarios), después se quita
  `blocked` y por último se mueve la columna: `update_issue` cambia la columna **antes** que los
  labels, así que en un solo paso el evento llegaría todavía `blocked` y el pipeline de la etapa lo
  ignoraría.
- **`task.resume_stage` sin etapa conocida** rechaza la acción (409) antes de tocar nada.
- **Un typo rompe el arranque**: cada `action:` tiene que estar registrada (`post_user_comment`,
  `update_issue`, las del proyecto…). Validalo con `bun run runner`.
- **Acciones del runner para los pasos**: `post_user_comment` (comentar a nombre de la persona),
  `check_pr_mergeable` y `merge_pr` (el PR de la tarea, de `pr.number`; un PR que no se puede
  mergear rechaza con 409 y no toca nada), `redispatch_task`, `rerun_review` y `stop_agent` (le piden al
  runner volver a despachar el último evento, volver a correr el review o pedirle al agente que
  pare; sólo con `--serve`).
- **Qué miran `available`, `when` y `with`** —los mismos hechos que publica `GET /api/tasks`—:
  `item.*` (`status`, `labels`, `type`, `repos`, `blocked`), `run.*` (la última corrida cerrada:
  `exit`, `status`, `failure_by`, `agent`, `summary`), `live.*` (la corrida viva: `status`,
  `agent`, `pause_id`, `ci`), `queue.waiting`, `task.*` (`idle_hours`, `waiting_hours`, `unlocks`,
  `blocked_by`) y `pr.number`. **Cada guarda dice por sí sola cuándo aplica**, también que no haya
  una corrida viva (`live.status notExists`): el runner no filtra después.
- **`GET /api/tasks`** publica, por cada card abierta del board —también Backlog y Todo—, esos
  hechos sin clasificar, qué acciones aplican ahora y la capacidad del runner (`running`,
  `waiting`, `paused`, `max_concurrent`, `free`). Qué es una decisión, en qué orden va y cómo se
  llama lo decide el dashboard de quien mira (la web); un runner sin web publica lo mismo.
  `GET /api/inbox` (ya clasificado) queda para el asistente y para clientes viejos.
- La web y el asistente leen el nombre, el campo de comentario y la confirmación de lo que el
  runner ofrece (`action_defs` de cada tarea); no los repiten.
- `add_to_project` y `mark_blocked_by` siguen escribiendo con la identidad del runner: sólo lo que
  pasa por el cliente de GitHub y el board (`update_issue`, `post_user_comment`) va a nombre de la
  persona.

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
la trae cada deploy (`--config` o `RUNNER_CONFIG`), en cualquier carpeta. Sus actions
importan `@ia-flow/*` y `zod`, y el bundle se los sirve como módulos virtuales
(`src/bundle/modules.ts`) — con las mismas instancias que usa el runner. Un paquete que no esté en
esa lista rompe el arranque del deploy.

`GET /health` contesta 200 mientras el proceso vive: es la probe de k8s y del balanceador.

## Tareas bloqueadas por otras (`mark_blocked_by`)

Una card con prerrequisitos abiertos no corre sus agentes (las pipelines filtran
`item.blocked`, salvo las de agentes que admiten correr bloqueados, como los refiners técnicos).
Cuando se mergea el PR del último prerrequisito, el intake (`intake-unblock`) busca en
GitHub los issues que ése bloqueaba (`dependencies/blocking`) y emite `issue.unblocked` para cada
uno que quedó sin bloqueadores abiertos. Las pipelines de
reentrada de cada columna lo escuchan, así que la card vuelve al agente que le toca donde esté.
Vale para PRs de cualquier repo del catálogo.

## Lo que no se portó del ejemplo

- Las tools `memory_*` del implementer: la memoria es el MCP oficial (`memory-mcp` en
  `runner.yaml`: en un deploy, `mcpHost.memory`; en local, `bun run memory-mcp`), no tools
  nativas.
