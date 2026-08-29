# ia-flow — Claude Code guide

Full-stack app that orchestrates AI coding agents against local repos and GitHub Projects. Bun monorepo.

## Stack

- **Runtime:** Bun (server + tooling), Node-compatible for Vite
- **Server:** Hono + `bun:sqlite`, WebSockets, Pino logs
- **Web:** Vue 3 + Vite + Pinia + Vue Router + Vitest
- **Shared:** Zod schemas + inferred types (source-only package)
- **Lint/format:** Biome (single tool, no ESLint/Prettier)
- **Tests:** `bun test` (server), Vitest (web + shared)

## Layout

```
apps/server/           Hono API + WS (IA_FLOW_SERVER_PORT, default 3001) — persists to ~/.config/ia-flow/ia-flow.sqlite
                       `src/main.ts` elige flavor: `full` (la API completa) o `runner` (engine headless)
                       `Dockerfile.runner` + `RUNNER-DEPLOY.md`: el flavor headless en contenedor
apps/web/              Vue 3 SPA (IA_FLOW_WEB_PORT, default 5173) — proxies /api and /ws al puerto del server
packages/shared/       Zod schemas + types, imported as @ia-flow/shared
packages/workspace/    Ciclo de vida de worktrees + provisioners (@ia-flow/workspace)
packages/github-auth/  Credenciales de GitHub: PAT / gh CLI / GitHub App (@ia-flow/github-auth)
packages/figma-auth/   Credencial OAuth (PKCE) del MCP remoto de Figma (@ia-flow/figma-auth)
scripts/               One-off ops scripts (GitHub Project setup, etc.)
.claude/               Agents, commands, hooks, settings for this repo
```

Cross-package dependency graph: `web → shared`, `server → shared`, `workspace → shared`,
`github-auth → shared`, `figma-auth → shared`. `shared` has no runtime deps beyond Zod. `workspace` y `github-auth` los
consumen dos apps que no comparten nada más —`apps/server` y `apps/ai-provider-gateway`—, que es
la razón de que sean paquetes propios y no rincones de `agent-engine` o `issue-sources`.

## Arquitectura

Dos estilos, uno por app. **No son negociables para código nuevo**: son lo que permite agregar
una feature sin releer toda la app.

- **`apps/server` — Ports & Adapters (hexagonal).** El núcleo (`domain` + `application`) no sabe
  qué base de datos, qué HTTP ni qué proveedor de IA hay debajo. Todo lo concreto entra por
  interfaces (`domain/ports/I*.ts`) y se cablea en un único lugar (`composition/container.ts`).
- **`apps/web` — Feature-sliced.** El código se agrupa por **dominio de negocio**
  (`features/agents/`, `features/tasks/`), no por tipo de archivo. Cada feature trae su
  `api.ts`, su `store.ts` y sus componentes juntos.
- **`packages/shared` — Contract-only.** Es la frontera server↔web. Sin lógica, sin I/O. Excepción
  deliberada: `src/cache.ts` (el decorator `@memoize`, ver más abajo) — es una utilidad genérica
  sin estado de dominio ni I/O propio, no una regla de negocio.

### La regla de dependencia

Una sola regla gobierna todo: **las dependencias apuntan hacia adentro, nunca hacia afuera.**

```
routes/ ─┐
daemon.ts┼─→ application/ ─→ domain/ ←─ infrastructure/
         │                     ▲              adapters/
composition/container.ts ──────┴── (único lugar que instancia lo concreto)
```

| Capa | Puede importar | NUNCA importa |
| --- | --- | --- |
| `domain/` | sólo `@ia-flow/shared` | nada del propio server. Cero I/O, cero `bun:sqlite`, cero `fetch`. |
| `application/` | `domain/**` + `@ia-flow/shared` | `infrastructure/**`, `adapters/**`, `composition/**` |
| `infrastructure/`, `adapters/` | `domain/**` (implementan sus ports) | `application/**`, `routes/**`, `composition/**` |
| `routes/` | `application/**`, `domain/**`, `composition/container` | `infrastructure/**`, `adapters/**` directo |
| `composition/` | todo | — es la hoja del grafo; nadie la importa salvo `routes/`, `index.ts`, `daemon.ts` |

**Corolario práctico:** si una clase de `application/` necesita hablar con GitHub o con SQLite,
**no la importa** — recibe un port por constructor y `container.ts` le inyecta la implementación.
Eso es lo que hace el código testeable sin mocks pesados y sustituible sin cirugía.

### Deuda conocida (no ampliar)

El núcleo `domain/` está limpio. Estas violaciones existen y están **toleradas donde ya están**,
pero **está prohibido crear nuevas**:

- `application/` importa adapters/infra concretos: `AgentOrchestrator.ts`, `branch-namer.ts`,
  `provider-config.ts`, `source-registry.ts`, `use-cases/AssistWithAiUseCase.ts`.
- `application/`, `adapters/` e `infrastructure/` importan `composition/container.js`
  (service locator — invierte la flecha). Código nuevo recibe dependencias por constructor.
- `routes/projects.ts` baja directo a `infrastructure/`.
- Carpetas fuera del esquema, heredadas: `issue-managers/`, `agents/`, `tools/`, `variables/`,
  `slack/`, `project-sources/`, `config/`. Conceptualmente `issue-managers/` y `agents/` son
  **application**, `tools/` y `slack/` son **adapters**. No muevas nada por gusto; cuando toques
  una de esas carpetas, no la hagas más profunda ni le agregues acceso directo a DB.

Cuando modifiques un archivo que ya viola la regla, déjalo al menos igual — nunca peor.

## Cómo el engine elige un agente

**El Agent es la entidad principal del sistema.** No hay una tabla que cablee "este status corre
estos agentes": cada agente declara sus propios criterios de activación y el engine, dado un issue,
se pregunta *¿qué agente aplica acá?*.

Los filtros se evalúan en orden. En Project/Repo/Status, **vacío = sin restricción**:

| # | Criterio | Campo | Matchea cuando |
| --- | --- | --- | --- |
| 0 | Scope | `statusName` / `when` | al menos uno de los dos está seteado — ver abajo por qué |
| 1 | Project | `projectId` | es `null` (agente global), o coincide con el proyecto del issue |
| 2 | Repo | `repoName` | es `null`, o el nombre está dentro de `task.repos[]` |
| 3 | Status | `statusName` | es `null`, o coincide con el status actual (case-insensitive) |
| 4 | When | `when` | las condiciones evalúan `true` contra los campos del issue (`evalWhen`) |
| 5 | WhenText | `whenText` | es `null`, o un Haiku lee el issue y dice que cumple el criterio |

De los candidatos habilitados que sobreviven todos, **se ejecuta el primero por `position`**.
Un dispatch corre **un** agente, no una cadena: sus outcomes (`onFinish` / `onError`) mueven el
issue al siguiente status y el próximo ciclo de scan vuelve a seleccionar contra el status nuevo.
Así avanza el pipeline sin que ningún componente conozca la cadena completa de antemano.

**Filtro 5 (WhenText) es el único impuro.** Los cuatro primeros son predicados sobre datos ya en
memoria — por eso `selectAgent` (`agent-selection.ts`) no tiene I/O y `TaskDispatcher` lo usa como
pre-check barato. `whenText` necesita que un modelo lea el issue, así que vive afuera envolviéndolo
(`agent-text-gate.ts` → `selectAgentGated`, que es lo que llama `resolveRunContext`). Es un **gate**,
no un desempate: descarta al agente aunque sea el único candidato — a diferencia del `whenText`
homónimo de `AgentProviderChoiceSchema`, que sólo desempata entre >1 provider. El veredicto se
cachea por (agente + criterio + contenido del issue), y si el clasificador no puede decidir el
dispatch se saltea entero para reintentar en el próximo scan, en vez de adivinar. Sin
`classifyAgent` inyectado (tests, deploys sin auth) el campo no filtra nada.

**Filtro 0 (Scope) no es cosmético.** Sin `statusName` NI `when`, un agente no tiene ningún
criterio que deje de cumplirse cuando termina su propio run — `statusName` nulo matchea
"cualquier status", así que el `onFinish` que mueve el issue a un status nuevo no lo saca de la
selección: el próximo ciclo lo vuelve a ver como candidato para el MISMO issue y lo re-ejecuta
sin freno. Antes esto quedaba acotado de facto porque `SourceIssueManager.runCycle` sólo
escaneaba los statuses que `ia-flow` tenía configurados (tabla `statuses`); ese prefiltro se
sacó (ver `source-issue-manager.ts` — ahora escanea todo lo que devuelve el source y deja que
`selectAgent` sea el único gate), así que el filtro 0 es lo que hoy evita el loop.

```
SourceIssueManager.runCycle   fetch únicamente — SIN prefiltro por status
  └─ TaskDispatcher.dispatch  gates: validate, health, projectId, selectAgent (los 5 filtros)
       └─ AgentOrchestrator.runAgent
            ├─ resolveRunContext → selectAgent   ← re-selecciona contra status fresco
            └─ Agent.run                          ← ciclo de vida del run
```

Piezas: `packages/agent-engine/src/agent-selection.ts` (los filtros, puro y testeable sin I/O),
`run-context.ts` (selección + layout de repos), `AgentOrchestrator.ts` (lock + cleanup).
El contrato vive en `AgentActivationSchema` / `AgentOutcomesSchema` (`packages/shared`).

`AgentActivationSchema.allowBlocked` (no `StatusConfig`) decide si el dispatcher corre el agente
igual cuando el issue está bloqueado — `TaskDispatcher.dispatch` lo lee del agente que
`selectAgent` matchea, no de una fila de status aparte. `StatusConfig` (`{ name, position }`) es
config de UI (`routes/statuses.ts`) — declara la etapa del pipeline para mostrarla/editarla, ya
no cablea nada del dispatch. Su campo `allowBlocked` sigue existiendo pero está deprecado.

## Capacidad — cuánto corre a la vez, y quién decide

Dos mecanismos distintos, no uno:

- **Caps declarativos**, que el operador edita en la UI y el engine cuenta.
- **Admisión**, donde el **provider** decide si toma la tarea. Es lo que el engine no puede
  deducir: la RAM del host, sesiones vivas, trabajo que no vino de este daemon, un rate limit
  propio del upstream.

Criterio común a todos los caps: **`0` o ausente = sin límite** (nunca "frenar todo" — un cap que
no puede despejarse dejaría el issue difiriéndose para siempre; para pausar un proyecto está
`polling-pause`). Los caps de proyecto y agente **difieren** el issue; el de provider participa
de la elección y hace que se **pruebe el siguiente candidato**.

| Scope | Dónde se declara | Dónde se evalúa | Qué cuenta |
| --- | --- | --- | --- |
| Proyecto | `project.settings.maxConcurrentDispatches` (UI: tab Provider) | `SourceDispatcher.atCapacity` | agentes corriendo de ese proyecto; sin valor cae a `IA_FLOW_MAX_CONCURRENT_DISPATCHES` |
| Agente | `AgentDefinition.maxConcurrentDispatches` (UI: editor de agente) | `TaskDispatcher` (pre-check barato) + `AgentOrchestrator` (autoritativo) | runs de ese agente, cruzando proyectos |
| Provider | `maxConcurrentRuns` en los settings del provider (`anthropicApi`, `tmuxClaude`, …; UI: la sección de ese provider) | `resolveProvider` | runs de ese provider despachados por ESTE daemon |
| Gateway | `GATEWAY_MAX_CONCURRENT_RUNS` (env de `apps/ai-provider-gateway`) | el gateway mismo | runs en vuelo en ESE proceso |

El cap del provider es **config adicional de ese provider**, junto a su model y sus mcpServers —
no una tabla de límites aparte. `composition/container.ts` arma con ellos el mapa por id
(`Record<string, ProviderLimit>`) que el engine consulta, así que un provider nuevo con su propio
bloque de settings se suma agregando una línea a `PROVIDER_SETTINGS_KEYS`. Los remotos no están
en ese mapa a propósito: su cap real lo lleva el gateway, que es el único que ve su ocupación
completa.

Los conteos salen del registry de pending tasks (`capacity.ts`, puro y testeable sin I/O) — una
entrada se registra justo antes de la llamada al provider, así que un item que los gates rechazan
nunca ocupa un slot (la starvation que arregló c547c73).

**`deferred` vs `skipped`.** `TaskDispatcher.dispatch` devuelve un `DispatchOutcome`
(`@ia-flow/issue-sources`): `skipped` suelta el item (no matcheó nada, está bloqueado —
reintentar no cambia el resultado) y `deferred` lo devuelve al backlog de `SourceDispatcher`,
que lo **replaya cuando se libera un slot, sin volver a pegarle a la fuente**. Sin esa
distinción un dispatch frenado por capacidad se perdía en silencio hasta el próximo scan.

### Admisión — `IAgentProvider.canAccept`

El engine no decide si un provider puede trabajar: le pasa los hechos que él ya tiene y le
pregunta (`packages/ai-providers/src/admission.ts`).

```ts
canAccept?(req: AdmissionRequest): Promise<Admission>
// req:  { task, agentId?, running, cap? }   ← running/cap los calcula el engine
// →     { accept: true } | { accept: false, reason, retryAfterMs? }
```

- **Recibe la tarea**, así que se puede rechazar por lo que ES (un repo que no tiene clonado),
  no sólo por ocupación.
- **Es opcional.** Sin implementar, el engine aplica `withinDeclaredCap(req)` — por eso el cap de
  la UI vale para todos los providers sin que ninguno escriba una línea. Un `canAccept` propio
  normalmente arranca llamando a ese mismo helper y agrega sus motivos encima.
- **Es consultivo y fail-open.** No reserva nada (entre el `accept` y el `run` puede entrar otro
  dispatch — es enrutamiento, no un lock), y ante cualquier accidente admite: un chequeo roto que
  congela el pipeline es peor que intentar, porque el fallo del run sí se reporta.
- **Rechazar no es fallar.** El motivo es texto para humanos y va al log del "diferido"; el issue
  se reintenta cuando se libere un slot.

Hoy lo implementa `RemoteAgentProvider`, que resuelve primero el cap local (gratis) y recién
después sonda `GET /v1/capacity` del gateway, propagando su `reason`. La palabra final la tiene
el gateway en `POST /v1/run`, que responde **503** (no 500: es "volvé después", no "esto falló").
Un chequeo nuevo del lado del gateway (RAM libre, carga del host) va en su función `capacity()`,
que es el único lugar que decide y ya devuelve el motivo junto con la respuesta.

### Salud — un remoto existe sólo mientras contesta

La admisión responde "¿podés tomar esto **ahora**?". Antes hay una pregunta más básica:
**¿existe?**. Un provider remoto vive en otra máquina que se apaga, se duerme o pierde la red, y
un `remote:<name>` registrado contra un gateway muerto era, hasta ahora, un provider elegible que
hacía **fallar** el run del agente — con su `onError` moviendo el issue y comentando un fallo que
nunca se intentó.

`RemoteProviderHealthMonitor` (`apps/server/src/adapters/remote-provider/`) sondea
`GET /v1/provider` de cada gateway registrado cada `IA_FLOW_REMOTE_HEALTH_INTERVAL_MS` (30s) y
**registra o desregistra** el `RemoteAgentProvider` según el resultado. "Disponible" en este
sistema significa *estar en el `ProviderRegistry`*: es lo que lista `GET /api/providers` (lo que
ofrece el editor de agentes) y lo que resuelve el orquestador al despachar. Un provider marcado
pero presente obligaría a cada consumidor a acordarse de filtrar; uno ausente es imposible de
elegir por construcción.

- **Un solo fallo alcanza para sacarlo.** El costo de sacarlo de más es que el issue se
  **difiere**; el de dejarlo de más es un run fallido de verdad.
- **`unknown` no es disponible.** Al bootear, los remotos persistidos ya no se re-registran a
  ciegas: los da de alta la primera ronda del monitor, no `index.ts`.
- **La registración NO se borra** — sigue en SQLite y listada por
  `GET /api/provider-registrations` con su `health` (status, error, fallos seguidos). Es donde el
  operador ve *por qué* desapareció de los providers, y desde donde puede forzar una sonda
  (`POST /api/provider-registrations/:id/health-check`) sin esperar el ciclo. Los cambios de
  estado se emiten por WS (`provider-health`).
- **Un id que no resuelve difiere, no falla.** `AgentOrchestrator.admitProvider` rechaza cuando el
  registry no conoce el id (antes admitía a ciegas y explotaba después, en `Agent.run`). Ojo con
  la contracara: un `provider:` mal escrito ahora difiere el issue en vez de fallar ruidosamente —
  el motivo queda en el log del "diferido".

## Dónde trabaja un agente — `prepareWorkspace`

**El engine describe el trabajo; el provider decide dónde aterriza.** Misma filosofía que la
admisión (`canAccept`): el engine aporta hechos, decide el provider.

```ts
prepareWorkspace?(req: WorkspaceRequest): Promise<WorkspacePlan>
// req:  { taskId, repos: [{ name, path?, githubOwner?, githubRepo? }], branch?, workflow?, needsWrite }
// →     { repoPaths, writePaths?, cwd?, branch?, worktreePath?, release?() }
```

- **El request lleva coordenadas, no paths de una máquina.** Por eso un provider remoto puede
  trabajar sobre un repo: el `WorkspaceRequest` viaja dentro del `ProviderInput` hasta el
  gateway, que lo valida en su borde y resuelve sus propios paths — clonando el repo si nunca
  lo vio (`GATEWAY_REPOS_BASE`). Antes el engine mandaba paths absolutos de SU disco y del otro
  lado no existían.
- **Es opcional.** Sin implementar, el run usa los paths que el engine ya conoce (el clone
  local, sin worktree) — que es lo que hace un host sin filesystem de proyecto.
- **El permiso de escritura NO es del provider.** Propone `writePaths`; el engine los intersecta
  contra las tools del agente (`hasWriteTools` → `intersectWritePaths`). El provider elige el
  dónde, nunca el si.
- **`release` es la contracara de `prepare`.** El provider que ensucia el disco declara cómo se
  limpia; el orquestador la invoca en su `finally` sin saber de qué provider vino.

Implementaciones (`@ia-flow/workspace`, inyectadas en `composition/container.ts`):

| Provisioner | Quién lo usa | Qué hace |
| --- | --- | --- |
| `WorktreeWorkspaceProvisioner` | providers sync (`anthropic-api`, y el mismo del otro lado del gateway) | worktree aislado + scopes read/write. Sin `release`: el worktree sobrevive al run para que el siguiente agente de la cadena lo herede. |
| `TerminalWorkspaceProvisioner` | tmux / iterm | obedece `repo.workflow`: `worktree` materializa y entra ahí; `branch`/`main` se quedan en el repo base. Trae `release` (auto-limpieza si no quedó trabajo en riesgo). |

**El lock por task es del engine, no del provider** (`AgentOrchestrator` lo toma para cualquier
provider): dos dispatches sobre la misma task no pueden pisarse el worktree.

**La convención de nombres es contrato compartido** (`layout.ts`):
`<base>/<repo>/.worktrees/task-<issue>` + branch `task.branch` (o `task/<id>`). Vale para todos
los provisioners: si cada uno la derivara por su cuenta, un builder en `anthropic-api` y un
reviewer en `tmux` sobre la misma task mirarían directorios distintos — que es exactamente lo
que pasaba cuando `terminal-base` tenía su propia copia de esta maquinaria.

## Qué viaja a un provider remoto — tools y MCP

La regla que hace entendible todo lo de abajo: **el gateway no reinterpreta al agente. Corre el
MISMO `AnthropicApiProvider` que correría el runner — lo único que cambia es de qué disco
cuelga.** El daemon resuelve todo antes de mandar; el gateway ejecuta.

El body del `POST /v1/run` es un `ProviderInput` completo y ya resuelto
(`packages/ai-providers/src/contract.ts`), autenticado con el bearer de la registración:

| Campo | Quién lo produjo | Para qué sirve del otro lado |
| --- | --- | --- |
| `prompt`, `systemPromptBlocks` | el daemon, con las variables ya renderizadas | el modelo lo recibe tal cual |
| `tools[]` | el `tools[]` del agente | `getToolDefinitions` arma el schema |
| `policy` | `application/policy.ts` compilado | el allow/deny de `bash_run` |
| `providerConfig.mcpServers` | catálogo expandido **y secretos ya interpolados** | va al request de Anthropic |
| `agentId`, `projectId` | el dispatch | el namespace de las tools `memory_*` |
| `selectableExits` | `AgentOutcomesSchema.exits` | el enum de `select_exit` |
| `workspace` | la *intención*: repos con coordenadas, branch, `needsWrite` | el gateway resuelve paths en SU disco |
| `daemonUrl` | `daemonPublicUrl()` | sólo lo usan los providers de terminal |

**Lo único que el gateway recalcula es el workspace** (`resolveWorkspace` en
`apps/ai-provider-gateway/src/app.ts`): clona bajo `GATEWAY_REPOS_BASE` si nunca vio el repo y
reescribe `repoPaths`/`writePaths` con paths suyos. Todo lo demás pasa verbatim a `provider.run()`.

### Dónde se ejecuta cada cosa — que no es dónde corre el modelo

| | Dónde corre |
| --- | --- |
| El loop de tools (`executeLoop`) | **el gateway** |
| `fs_*`, `bash_run` | **el disco del gateway**, con la misma `policy` |
| `memory_*` | el gateway, contra el namespace `(agentId, projectId)` que vino en el input |
| **Los MCP HTTP** | **los servidores de Anthropic** — no el gateway |

Ese último sorprende. `anthropic-api` usa el **conector MCP de la API** (beta
`mcp-client-2025-11-20`, `body.mcp_servers`): la config viaja a Anthropic y **Anthropic abre la
conexión** contra el MCP. El gateway nunca le habla. Corolario: **las entradas `stdio` se
descartan** en ese camino — no son soportadas remotamente, y un agente que dependa de una queda
sin esa capacidad sin que nada falle.

### El camino async es al revés

Un provider de terminal (`tmux-claude`, `iterm-claude`) no recibe las tools del engine: recibe un
MCP sintético `ia-flow-tools` apuntando a `<daemonUrl>/api/mcp?tools=…&agent=…&project=…&run=…`
(`terminal/base.ts`). O sea que **las tools inyectadas se ejecutan en el DAEMON**, no donde corre
el CLI. Por eso `daemonUrl` no es decorativo: sin él el run arranca sin ninguna tool. Y el
resultado no vuelve en la respuesta HTTP — vuelve por el callback `complete_task`/`fail_task`.

Lo que **sí** corre donde está el CLI son sus tools NATIVAS (su Bash, su Read/Write). De ahí que
un run de terminal tenga dos discos en juego, y que `bash_run` y `workspace_reset` sean
`providerKinds: ['sync']`: en async el CLI ya trae lo equivalente, localmente.

### Las tools por `providerKinds`

De las 31 registradas en `packages/tools/src`, casi todas se ofrecen a los dos mundos. Las
excepciones son las que importan:

| Alcance | Tools | Por qué |
| --- | --- | --- |
| Sólo `sync` | `bash_run`, `workspace_reset` | en async el CLI ya trae Bash nativo; exponerlas mandaría la ejecución al disco equivocado |
| Sólo `async` | `complete_task` | en sync el run lo cierra el engine leyendo `stopReason`, no el modelo |
| Ambos | las 28 restantes | `fs_*` (5), fuente de issues (7), GitHub (6), Slack (5), `memory_*` (5) |

**`fs_*` en el camino async es el filo que queda**: se exponen (no declaran `providerKinds`), y
`/api/mcp` los resuelve con `providerKind: 'async'`, así que **leen y escriben en el disco del
daemon** mientras el Read/Write nativo del CLI opera en el del gateway. Un agente que declare
`fs_write` y corra en terminal remoto escribe en la máquina equivocada. Hasta que se les ponga
`providerKinds: ['sync']` —el mismo tratamiento que ya tiene `bash_run`, por el mismo motivo— la
regla operativa es: **un agente que vaya a correr en terminal no declara `fs_*`**.

Las otras 23 están bien donde están: la fuente de issues, GitHub, Slack y la memoria son estado
del daemon, y moverlas al gateway obligaría a cada uno a tener la conexión al source, las
credenciales y las convenciones de marcadores. La memoria además **debe** ser del daemon: es lo
que la hace compartida entre providers y entre máquinas.

### Tres detalles que muerden

- **Los secretos de MCP cruzan el cable ya resueltos.** `setSecretResolver` está cableado sólo en
  `apps/server/src/composition/container.ts`, así que `interpolateMcpServers` corre en el daemon y
  el `${GITHUB_TOKEN}` del `runner.yaml` viaja convertido en el token real dentro del JSON. Cada
  gateway al que despaches queda confiado con ese token.
- **El gateway resuelve su PROPIA credencial de git.** Son dos identidades: el token del MCP viene
  del daemon, pero para clonar y pushear el gateway usa la suya (`providers.ts`).
- **`policy.toolNames` es un `Set`**, y `JSON.stringify` lo serializa a `{}`. `RemoteAgentProvider`
  lo reconvierte a array a mano; sin eso el gateway recibía la allow-list vacía y explotaba en el
  spread.

### Lo que esto implica para un gateway por stack

Las tools y los MCP **no necesitan nada por stack**: el schema lo arma el daemon, los MCP los
conecta Anthropic, y lo único que toca un toolchain es `bash_run` sobre el disco del gateway. O
sea que un `gateway-node` o un `gateway-flutter` es *un disco con binarios encima del mismo
binario del gateway* — sin config de tools que duplicar ni catálogo MCP que replicar.

La condición es que corra `GATEWAY_PROVIDER=anthropic-api`. En modo terminal el toolchain sigue
siendo alcanzable (el Bash nativo del CLI corre ahí), pero se pierden dos cosas que en un quality
gate no son negociables: el allow/deny de `bash_run` **no aplica** al Bash del CLI, y los `fs_*`
inyectados apuntan al otro disco.

## Comentarios — dónde vive lo que un agente reporta

Un agente que despierta pregunta *¿qué pasó desde mi última corrida?*. Hasta hace poco esa
pregunta sólo se contestaba con el **issue**, y el pipeline deja la mitad de sus hallazgos en el
**PR**: el reporte de CI, el bug de runtime, y sobre todo la review humana — un canal
completamente muerto (nadie la leía nunca, aunque el MCP de GitHub tuviera las tools para
hacerlo).

### Leer: la conversación de una task es el issue MÁS sus PRs abiertos

`loadComments` (`packages/issue-sources/src/github-shared/conversation.ts`) devuelve, mergeados
por fecha, los comentarios del issue, los de la pestaña Conversation de sus PRs abiertos, y sus
**review threads sin resolver** (con `path:línea` y `threadId`). Cada `TaskComment` lleva su
`origin`, y `{{task.comments}}` lo rinde como `[fecha · PR #482 · review · core/twilio.py:88]`.

Es **una sola query**: en la API v4 un PullRequest expone `comments` igual que un Issue, así que
es `nodes(ids: [issueId, ...prIds])`, y los node ids ya venían gratis en `meta.pullRequests`.
Cero round-trips nuevos en el dispatch.

`selectCommentWindow` sigue funcionando sin cambios — corta por recencia contra el `# <agentId>`
del último comentario propio, y le da igual de dónde vino cada entrada.

### Escribir: `comment`, y la regla que lo gobierna

> **El comentario vive donde vive lo que el hallazgo cambia.** Si cambia QUÉ hay que construir
> (el PRD, el alcance) → **issue**. Si critica CÓMO está escrito este código → **PR**.

Se resuelve **salida > agente > `pr-else-issue`** (`resolveCommentTarget` en `shared`,
`resolveExitCommentTarget` en `agent-engine/src/run-outcome.ts`, al lado de `resolveExit` y
contra la misma salida que el run va a aplicar).

| Nivel | Dónde se declara | Para qué existe |
| --- | --- | --- |
| Default | — (`pr-else-issue`) | Con un PR abierto casi todo comentario del pipeline es del código. Cubre a casi todo el roster sin escribir config, y cae al issue solo cuando no hay PR. |
| Agente | `AgentDefinition.comment` | Un refiner produce el PRD, y el PRD **es** el issue: una línea en vez de una por salida. |
| Salida | `AgentExitSchema.comment` (forma larga) | El único nivel que puede expresar que un mismo agente mande un hallazgo al PR y otro al issue. |

Ese último es el caso que lo motivó: un **e2e-tester** que reporta un bug de runtime pertenece al
PR, pero uno que manda el issue de vuelta a refinamiento pertenece al **issue** — el PR que lo
motivó se cierra cuando el enfoque cambia, y ahí el hallazgo quedaría enterrado en un PR cerrado
que ya nadie lee.

**Elegir mal nunca esconde nada**: como la lectura mergea issue + PRs para todos los agentes, el
destino decide dónde queda registrado de forma *durable*, no quién puede verlo. Eso es lo que
hace seguro adoptarlo de a poco.

**Sólo PRs abiertos**, en las dos direcciones y por el mismo motivo: comentar en un PR mergeado
es carta muerta, y leer los comentarios de un intento abandonado compite con el intento vivo.
Un `draft` sí entra — está abierto y es donde está el trabajo. Un `comment: pr` sin PR abierto
cae al issue con un warn, no falla: perder el reporte de un run es peor que dejarlo en el lugar
menos específico.

**Ningún agente publica su reporte con `add_issue_comment` del MCP.** Además de duplicarlo, un
comentario que pasa por el engine lleva el marker `<!-- ia-flow:system-comment -->` y el header
`# <agente>` que `selectCommentWindow` necesita; uno escrito por el MCP es indistinguible de
feedback humano y el pipeline no puede razonar sobre él.

### Las review threads no se marcan como "usadas"

Un comentario del issue se consume y se marca (`markCommentsUsed` le anexa un marker al body).
Una review **no**: su señal de "ya está atendido" es la que GitHub ya modela — `isResolved` — y
mutar el body del comentario de un humano sería pisarle su propio registro. Por eso salen sin
`id` (así `markCommentsUsed` las saltea) y siguen apareciendo en cada run hasta resolverse. Que
un pedido sin resolver insista es lo correcto, no ruido.

La contracara escribible son dos tools (`packages/tools/src/github/tools.ts`):
`reply_pr_review_thread` y `resolve_pr_review_thread`, que toman el `threadId` que la propia
inyección le dio al agente. **Leer se inyecta, escribir es una tool**: la lectura tiene que estar
garantizada (una tool de lectura es capacidad sin uso — el MCP de GitHub ya la tenía y nadie la
llamaba), mientras que contestar y resolver son decisiones que el agente sólo puede tomar después
de arreglar el código.

## Memoria de los agentes — lo único que sobrevive a un run

Un dispatch arranca en frío: el agente ve el issue, sus comentarios y el repo, y nada de lo que
él mismo aprendió la vez anterior. Las tools `memory_*` son un KV persistente donde puede dejarse
notas — decisiones tomadas, convenciones del repo, el número del último PR — y leerlas cuando
vuelva a despertar.

**El namespace lo pone el runtime, no el modelo.** Cada entrada vive bajo `(agentId, projectId)` y
esos dos valores salen del dispatch, nunca de un argumento de la tool. Si el modelo pudiera
nombrar su propio namespace, escribir en la memoria de otro agente sería una alucinación de
distancia; así es imposible por construcción. Por eso viajan como viajan:

| Provider | Cómo llega el namespace |
| --- | --- |
| `anthropic-api` (sync) | `ProviderInput.agentId`/`.projectId` → `ToolContext` (`provider.ts`) |
| `tmux` / `iterm` (async) | `?agent=` / `?project=` en la URL de `/api/mcp`, al lado de `?tools=` y `?run=` (`terminal/base.ts`) |

Sin `agentId` la tool **rechaza** en vez de caer a un namespace compartido: una memoria que se
mezcla entre agentes es peor que no tener memoria.

`projectId: ''` es la memoria **global** del agente, y es una fila propia — no un caso especial.
Es un string vacío y no un `NULL` porque forma parte de la primary key, y en SQLite dos `NULL`
nunca comparan iguales: con `NULL` el mismo agente insertaría la misma key global N veces en vez
de pisarla. El agente elige con `scope: 'project' | 'global'` (default `project`).

**Es opt-in, sin auto-inject.** Un agente ve las tools sólo si tiene `memory_*` en su `tools[]`
—marcadas en el editor de agentes, que lista lo que devuelve `GET /api/tools`—. No hay entrada de
catálogo MCP que activarlas: `terminal/base.ts` ya inyecta el server sintético `ia-flow-tools`
para todo agente con `tools[]`, así que tmux/iterm y `anthropic-api` se activan con el **mismo**
mecanismo. Un segundo camino sólo agregaría una forma más de que la memoria quede a medio
configurar (y sembrar esa entrada desde una migración está prohibido — ver la regla de
migraciones más arriba).

Las cinco tools (`packages/tools/src/memory/memory.ts`): `memory_store`, `memory_retrieve`,
`memory_search` (`LIKE` sobre key **o** value, sin embeddings), `memory_list` (inventario de keys,
sin values) y `memory_delete`. Topes: key ≤ 256 chars, value ≤ 64 KB — rechazados con el motivo,
no truncados en silencio.

El store entra por un port (`AgentMemoryPort`, async aunque hoy sea SQLite local, para que mover
la memoria a otro lado no obligue a tocar las tools) que `composition/container.ts` cablea contra
`agentMemoryRepo`. Como todo repo dual, sale de `pickRepo`: SQLite (tabla `agent_memories`,
migración 056) o `IA_FLOW_AGENT_MEMORY_REPO=yaml`, que es **de solo lectura** — el caso del deploy
headless que le da a sus agentes un contexto fijo por archivo. Ahí las escrituras **tiran**: un
agente que cree que guardó algo y no lo guardó es peor que uno que ve el error y sigue sin
memoria.

## Pedido de review en Slack

El pipeline deja el PR listo con el CI corrido y ahí se cortaba: pedirle review a un humano o a un
bot revisor era un paso manual fuera de ia-flow. La tarjeta de tarea ahora lo hace —
`POST /api/tasks/:id/slack-review`, o la tool `request_slack_review` desde un agente — y el
segundo pedido cae **dentro del mismo hilo** en vez de abrir uno nuevo.

**A quién taguear es config del repo**, no conocimiento de quien pide el review: `repos`
(`slackReviewChannel` + `slackReviewers`, en el editor de repos). Los dos campos caen **por
separado** a los homónimos de `project.settings` — `resolveSlackReviewTarget` en
`@ia-flow/shared` — porque lo normal es un canal para todo el proyecto y distinta gente por repo.
Una lista vacía en el repo **hereda**: para no pedir review acá simplemente no se configura nada
y el botón queda apagado con el motivo.

El default del proyecto se edita **arriba del listado de tareas** (`SlackReviewSettings.vue`), no
en la tab del provider: es la config del botón que está en cada tarjeta de abajo, así que el
operador que ve "sin reviewers" tiene el arreglo a la vista sin cambiar de pantalla.

**El picker de canales muestra lo que el BOT ve, no el workspace.** `conversations.list` sólo
devuelve los canales donde la app está instalada (y los privados sólo si es miembro), así que la
lista puede ser mucho más corta que Slack. Por eso el campo acepta texto libre: un canal que no
aparece se pega por id y funciona igual. Los dos tipos se piden en llamadas **separadas** — con
un solo `types:` un scope faltante en privados dejaba el picker sin ningún canal.

El gate es **CI terminado, no CI verde**: `isCiFinished` (`github-shared/dev-links.ts`) mira el
`statusCheckRollup` del último commit, que viaja en la misma selección de PRs que ya se pedía —
cero requests nuevos. Un PR **sin checks** cuenta como terminado (si no, todo repo sin pipeline
quedaría con el botón apagado para siempre), y uno en rojo pide confirmación explícita
(`allowFailedCi`) en vez de bloquear.

### Dónde vive el link del hilo — lo decide el task source

No hay un lugar fijo: `ProjectSource.get/setSlackThreadUrl` deja que cada fuente use el soporte
que tiene. Un lugar fijo obligaría a las fuentes sin ese soporte a inventarlo.

| Source | Dónde | Lectura |
| --- | --- | --- |
| `github-project` | campo de texto del board (`source.config.slackThreadField`, default `SlackThread`; `null` ⇒ cae al PR) | gratis — ya viene en `fields` |
| `github-issues` | sección `## Slack` en el cuerpo del **issue** (canónica) + copia en el del PR | gratis — el body del issue ya viene en el scan |
| `local-fs` | `sections.Slack` del YAML | gratis |

`slackThreadField` se valida en el borde con `parseSlackThreadField`, mismo patrón que
`workingMarker`: mal escrito falla al guardar el proyecto, no en el primer pedido de review.
La sección usa un marker HTML (`<!-- ia-flow:slack -->`) y no el heading, para que el upsert no
le pise un `## Slack` que escribió un humano. El helper (`github-shared/slack-section.ts`) es
puro y no sabe si el body es de un issue o de un PR.

**`github-issues` es el único que escribe en dos lados, y la regla de precedencia es fija: gana
el issue.** No es duplicación accidental — cada copia paga algo distinto. El cuerpo del issue ya
viene en el scan, así que leerlo es gratis: es lo que permite publicar `meta.slackThreadUrl` y
que la tarjeta muestre "Pedir re-review" *antes* de que la toques, y además sobrevive al PR (si
se cierra uno y se abre otro, el hilo sigue siendo el de la tarea). El cuerpo del PR es la copia
visible, para quien lo abre sin pasar por ia-flow; que su escritura falle no invalida el guardado
(queda un warn). La lectura cae al PR sólo cuando el issue no tiene nada — que es el caso de los
links escritos antes de este cambio: se migran solos en el próximo pedido de review.

**El cuerpo del issue tiene dos dueños**, y por eso existe `preserveSlackSection`: el link lo
escribe `setSlackThreadUrl`, pero el PRD lo reescribe **entero** un agente (`saveOutput`) o el
editor de tareas (`updateItem`). Los dos re-adjuntan el bloque existente antes de escribir; sin
eso, el primer refinamiento posterior a un pedido de review borraba el link y el siguiente pedido
abría un hilo nuevo. En la otra dirección, `toIssueItem` lo saca de `description`: es bookkeeping
nuestro, no parte del PRD que lee el agente.

Cuando la fuente puede resolver el link **sin I/O**, además lo publica en
`SourceItem.meta.slackThreadUrl` — es lo que dibuja el tag del hilo en la tarjeta sin llamar a
nada. Hoy lo hacen las tres.

**Guardar el link es best-effort.** Cuando corre, el mensaje ya está publicado: fallar el request
ahí dejaría al operador creyendo que no se pidió nada. El fallo vuelve como `threadNotPersisted`
(un warning), y una fuente sin `setSlackThreadUrl` publica igual — sólo pierde la continuidad del
hilo.

`SLACK_BOT_TOKEN` necesita `chat:write` + `users:read` (el autocomplete de reviewers). Slack no
tiene búsqueda server-side de usuarios: `SlackDirectory` (`adapters/slack/`) lista el workspace
una vez con `@memoize` y filtra en memoria.

## Credenciales de GitHub — una identidad, tres formas de conseguirla

Todo lo que este proceso habla con GitHub —la API (GraphQL/REST de `issue-sources`), git
(`WorkspaceManager`) y el MCP oficial de GitHub— usa **una sola** credencial, resuelta por
`@ia-flow/github-auth` detrás del contrato `ICredentialProvider` (`packages/shared/src/credentials.ts`).

| Modo | Identidad | Renovación | Para qué |
| --- | --- | --- | --- |
| `static` | PAT (`GITHUB_TOKEN`) | ninguna | fallback, CI, tests |
| `gh-cli` | tu usuario, vía `gh auth token` | la hace `gh` | dev local sin configurar nada |
| `github-app` | `<app>[bot]` | JWT → installation token, cada ~55' | el daemon desatendido |

`IA_FLOW_GITHUB_AUTH_MODE=auto` (default) prueba **app → PAT → gh** y se queda con la primera
*configurada*: los dos primeros los configuró alguien en ia-flow, `gh` es estado ambiental de la
máquina y va último para no cambiar de identidad en silencio en un host que ya tenía un PAT. Qué
estrategia ganó
se loguea al boot y sale en `describe()`; una cadena silenciosa dejaría sin respuesta la pregunta
"¿con qué identidad se escribió este comentario?". Las cinco variables son editables desde
Settings (`ENV_VAR_DEFINITIONS`, grupo `github`), no sólo por `.env`.

**La regla que hace que esto funcione: el token se resuelve por uso, nunca se captura.** Un
installation token vive una hora y el daemon vive días — `githubToken: Bun.env.GITHUB_TOKEN`
capturado en un constructor daba 403 en silencio a los 60'. Por eso `WorkspaceManager` recibe
`() => Promise<string|undefined>` en vez de un `string`, `gql`/`rest` llaman a `getGitHubToken()`
por request, y el `${GITHUB_TOKEN}` de una config de MCP pasa por `setSecretResolver`
(`agent-engine`) en vez de leer el env. Cualquier consumidor nuevo sigue la misma regla.

Se cablea en los dos composition roots (`apps/server/src/composition/container.ts` y
`apps/ai-provider-gateway/src/providers.ts`) con `lazyGitHubCredentials`: perezoso porque
`envRepo.loadIntoProcess()` corre **después** de que el container se evalúa, así que leer el env
al importar no vería lo guardado en SQLite.

**Por qué `github-auth` no vive dentro de `issue-sources`:** el token de GitHub tiene un
consumidor que no es un issue source — `WorkspaceManager` lo usa para clonar y pushear. Meterlo
ahí crearía la arista `workspace → issue-sources` y obligaría al gateway a tragarse el GraphQL de
Projects V2 para conseguir un string con el que hacer `git clone`. GitHub es el raro porque es
tres cosas a la vez (issue source + remote de git + servidor MCP); Linear va a ser sólo un issue
source y su auth **sí** va adentro de `issue-sources`, como la de Slack ya vive junto a su
cliente en `packages/tools/src/slack/`. Ver `packages/github-auth/CLAUDE.md`.

## Cache transversal — `@memoize`

`@ia-flow/shared` (`src/cache.ts`) expone un decorator de método genérico para memoizar
resultados por instancia, en vez de que cada adapter/source arme a mano un `Map<key, {value,
at}>` junto a la clase (así vivía el cache de `GitHubProjectSource` antes de esto).

```ts
import { memoize, invalidateMemoized, peekMemoized } from '@ia-flow/shared'

class GitHubProjectSource {
  @memoize({ ttlMs: 5 * 60_000, key: () => 'meta', bypass: (opts) => opts?.refresh === true })
  private loadMeta(opts?: { refresh?: boolean }) { /* ... */ }
}
```

- **Storage por instancia** (`WeakMap` keyed por `this`) — dos instancias de la misma clase
  (ej. dos proyectos GitHub con URLs distintas) no comparten cache, y muere con la instancia sin
  necesidad de teardown manual.
- **`ttlMs`** — default: para siempre (hasta invalidar). **`key`** — default:
  `JSON.stringify(args)`; usa una key constante (`() => 'algo'`) cuando el método tiene un flag
  tipo `refresh` que NO debería partir el cache en entradas separadas. **`bypass`** — cuándo
  saltar la lectura del cache sin dejar de repoblarlo (así es como `refresh: true` fuerza un
  refetch sin crear una segunda entrada).
- **Promesas en vuelo se comparten**: dos llamadas concurrentes a un método async decorado
  dedupean sobre la misma promesa pendiente. Un `reject` no se cachea.
- **`invalidateMemoized(instance, methodName?)`** — dropea un método o toda la instancia.
  **`peekMemoized(instance, methodName, key)`** — lectura sync de una entrada ya resuelta, para
  interfaces que no pueden volverse `async` (ver `GitHubProjectSource.getTransitionManager`,
  que rehidrata `ProjectMeta` sin poder esperar una promesa).
- Requiere `experimentalDecorators: true` en el `tsconfig.json` de cualquier paquete que use
  `@memoize` — Bun no aplica el reemplazo de los decorators TC39 (stage-3) en su transpiler,
  sólo el legado. Ya está habilitado en `shared`, `issue-sources`, `agent-engine`, `tools` y
  `apps/server` (los que hoy tocan un archivo con `@memoize`).
- Preferí esto a que el registry (`createSourceFactory`, `packages/issue-sources`) cachee
  instancias con lógica de invalidación por-provider: ahora el registry sólo dropea la instancia
  vieja (su cache memoizado muere con ella por el `WeakMap`) y el próximo `get()` construye una
  fresca — la fuente misma es dueña de su cache, no el registry que la construye.

## Modularidad — reglas para que el código escale

- **Un módulo = un dominio, no un tipo de archivo.** Antes de crear `utils.ts`, `helpers.ts` o
  `common/`, pregúntate a qué dominio pertenece la función y ponla ahí. `utils.ts` es donde el
  acoplamiento se esconde.
- **Contra la duplicación, la tercera vez.** Dos usos parecidos pueden divergir; al **tercero**
  extrae la abstracción. Abstraer en el primero produce parámetros booleanos y ramas muertas.
- **Interfaces angostas.** Un port declara lo que el consumidor necesita, no todo lo que el
  proveedor sabe hacer. Si un `I*` crece a 15 métodos, probablemente son dos ports.
- **Dirección de la dependencia > cantidad de capas.** No agregues un use-case sólo por
  simetría: si una ruta sólo lee y devuelve una lista, `routes → repo (port)` está bien. El
  use-case aparece cuando hay **decisión de negocio** (orquestar, validar reglas, coordinar 2+
  ports).
- **Límites de tamaño** (señal, no dogma): archivo TS > 400 líneas, `.vue` > 300 líneas, o
  función > 50 líneas → divide antes de terminar el cambio.
- **Sin ciclos.** Si A importa B y B importa A, extrae el tipo/interfaz compartido a `domain/`
  (server) o a `@ia-flow/shared` (cruce de apps).
- **Efectos en los bordes.** Lógica de negocio en funciones puras y testeables; I/O (DB, red,
  fs, `process.env`) en la capa de afuera. Es la razón por la que `policy.ts` o `branch-namer`
  se pueden testear sin levantar nada.
- **Feature nueva = vertical completa**, no una capa a la vez: schema en `shared` → port si hace
  falta → use-case/repo → ruta → feature de web → tests de cada pieza.

## Paridad API ↔ front

Cuando un cambio agrega o modifica algo consumible desde HTTP (endpoint nuevo, campo de
`providerConfig`, campo de schema en `packages/shared`, config de agente/proyecto), evalúa
**explícitamente** si `apps/web` necesita un control para editarlo o verlo. No es automático: un
flag interno de debugging no necesita UI; un knob de agente nuevo (ej. `effort`,
`taskBudgetTokens`) normalmente sí.

- **Si aplica y entra en el alcance del cambio actual**, hazlo ahí mismo — no dejes un campo
  "editable solo por API/DB" salvo que sea explícitamente interno.
- **Si aplica pero no es parte del alcance actual** (otro dominio, requiere diseño de UI, cambio
  demasiado grande para meterlo de paso), no lo dejes como deuda silenciosa: como mínimo crea un
  issue en ia-flow con el skill `/add-issue` (o `POST /api/tasks`) describiendo el campo/endpoint
  y dónde debería exponerse, para que quede rastreado y ejecutable por los agentes del engine.
- **Si no aplica** (config interna, flag de test, algo que solo usa el engine), dilo
  explícitamente en el commit/PR — evita que quede como duda para quien lea el diff después.

Ejemplo real de lo que esta regla busca evitar: `maxPauseTurnRetries`, `retryTruncatedToolUse` y
`thinkingBudgetTokens` se agregaron a `AnthropicApiAgentConfigSchema`
(`packages/ai-providers/src/anthropic-api/provider.ts`) sin campo correspondiente en
`apps/web/src/features/agents/providerForms/AnthropicApiProviderForm.vue` — quedaron editables
solo vía API/DB hasta que alguien lo notó y hubo que corregirlo en un cambio aparte.

## Imágenes — el bundle es el artefacto

**Cada `Dockerfile` vive junto a su app**, y se construye siempre con la **raíz
del repo como contexto**: la imagen necesita el workspace de Bun completo,
porque los `packages/*` son `workspace:*` y no están publicados.

```bash
podman build -f apps/ai-provider-gateway/Dockerfile -t ia-flow-gateway .
podman build -f apps/server/Dockerfile.runner       -t ia-flow-runner   .
```

`podman` y `docker` sirven los dos; nada asume uno. **El runner está pinneado a
`linux/amd64`** (los nodos del cluster son amd64): en una Mac arm64 construye
por emulación y tarda varios minutos — es esperado, no un cuelgue.

### Bundle, sin `node_modules`

Las dos imágenes se construyen igual: un stage de build que hace `bun build`
sobre el entrypoint, y un stage de runtime que copia **un solo archivo**.
Ninguna instala dependencias en la imagen final.

**Por qué no enumerar paquetes.** El gateway lo hacía —manifest por manifest,
`bun install` en la imagen final— y esa lista se desincronizó sola: cuando
apareció `packages/github-auth` nadie la actualizó y el build empezó a morir con
`@ia-flow/github-auth@workspace:* failed to resolve`. `bun build` sigue el grafo
de imports solo, así que una dependencia nueva no toca ningún `Dockerfile`.

**La consecuencia al escribir código:** sin `node_modules` en runtime, cualquier
cosa que resuelva un módulo **por nombre y en runtime** no existe. El caso ya
pagado son los targets de `pino.transport`: se resuelven dentro de un worker
thread que muere al no encontrarlos, y `thread-stream` lo reintenta por cada
línea — un loop de `{"err":{"message":"the worker has exited"}}` hasta que el
cgroup mata al contenedor con `Exited (137)`, sin nombrar el módulo faltante en
ningún lado. Por eso los dos loggers arman sus sinks **in-process**, importando
`pino-pretty` y `pino-roll` como módulos (ver `apps/server/src/logger-sinks.ts`
y el bloque de sinks de `apps/ai-provider-gateway/src/logger.ts`). Lo mismo vale
para `import.meta.dir` / `import.meta.url`: los dos usos que quedaban aceptan un
override por env (`IA_FLOW_TASKS_ROOT`, `IA_FLOW_HOOK_SCRIPT_PATH`).

`LOG_PLAIN=true` lo ponen las dos imágenes: NDJSON crudo a stdout, que es lo que
un runtime de contenedores sabe juntar.

### No se publican imágenes

Lo que sale en cada release es el **bundle** (`ia-flow-server.js` y sus dos
hermanos, ~2 MB). Son dos caminos distintos, no uno mejor que el otro:

| | el `Dockerfile` de la app | el artefacto de la release |
| --- | --- | --- |
| De dónde sale el código | del working tree (`COPY . .` + `bun build`) | de una release ya publicada |
| Para qué | correr un commit **sin publicar** | consumirlo desde OTRO repo (es lo que hace `claw-agents`) |
| Quién elige la imagen base | nosotros | vos |

Una imagen le impone al consumidor la base que elegimos nosotros —nuestra
Debian, nuestros paquetes, nuestro usuario, nuestro ciclo de parches—. Un bundle
se referencia con un `ADD` desde el Dockerfile de quien lo usa:

```dockerfile
FROM oven/bun:1.1.30-slim
ADD --chmod=644 https://github.com/julianjab/ia-flow/releases/download/vX.Y.Z/ia-flow-server.js /app/server.js
ENTRYPOINT ["bun", "run", "/app/server.js"]
```

`--chmod=644` no es cosmético: `ADD <url>` baja el archivo como
`-rw------- root root`, así que cualquier imagen con un `USER` no-root moriría
con "permission denied" sin que el error mencione al `ADD`.

Cada `.tar.gz` de la release trae ese bundle más un `Dockerfile.example`
completo y un README, generados por `scripts/package-release.ts` — que es
también donde vive el pin de Bun que viaja adentro de cada artefacto. **El
bundle necesita Bun**, no es un binario; lo que NO necesita es `node_modules`,
ni el repo, ni un `bun install`.

## Commands

```bash
bun install                # install everything
bun run dev                # server + web in parallel
bun run dev:server         # server only (IA_FLOW_SERVER_PORT, default 3001)
bun run dev:web            # web only (5173)
bun run build              # shared → server → web
bun run test               # all workspaces
bun run typecheck          # all workspaces
bun run lint               # biome lint
bun run format             # biome format --write
bun run check              # biome check + typecheck + test (pre-push)
```

## Puertos

Ambos puertos se configuran por env; los defaults siguen siendo 3001/5173.

| Var | Qué mueve | Default |
| --- | --- | --- |
| `IA_FLOW_SERVER_PORT` (alias legacy: `PORT`) | puerto de `apps/server` **y** el destino del proxy de la web | `3001` |
| `IA_FLOW_WEB_PORT` (alias: `VITE_WEB_PORT`) | puerto del dev server y del `preview` de Vite | `5173` |
| `VITE_API_TARGET` | override completo del destino del proxy (host incluido) — gana sobre `IA_FLOW_SERVER_PORT` | — |

`vite.config.ts` lee el `.env` de la raíz del repo y el de `apps/web` (este último gana), así que
un solo `.env` en la raíz con `IA_FLOW_SERVER_PORT` + `IA_FLOW_WEB_PORT` mueve las dos apps. Un
valor exportado en el shell gana sobre ambos archivos. Cuando el puerto de la web viene de env,
Vite corre con `strictPort` — falla en vez de saltar al siguiente libre.

**Never push without `bun run check` passing.** See [~/.claude/CLAUDE.md](@~/.claude/CLAUDE.md).

## Conventions

- **Branching:** por defecto trabajar en `main`; feature branches permitidas cuando el trabajo lo justifique.
- **Naming:** camelCase (TS), PascalCase (types/components), SCREAMING_SNAKE_CASE (env), snake_case (payloads / DB columns).
- **Imports:** server usa extensiones `.js` en imports (ESM Bun). Web usa alias `@/*`. Compartido se importa como `@ia-flow/shared`.
- **Schemas:** todo tipo cruzando la frontera server↔web vive en `packages/shared/src/schemas.ts` (Zod) — la web valida respuestas con `.parse()`.
- **DB:** SQLite via `bun:sqlite`. Migraciones numeradas en `apps/server/src/migrations/` + registro explícito en `runner.ts`. Path configurable con `IA_FLOW_DB_PATH`.
- **Una migración sólo lleva estructura de la base, y configuración que vive
  únicamente en la base.** Nada de sembrar lo que el operador configura y que
  además tiene otra fuente (prompts y tools de agentes, statuses, system prompts,
  entradas del catálogo MCP, scan roots): esos viven en la UI o en el YAML de un
  deploy, así que sembrarlos hace que actualizar el producto reescriba lo que
  alguien editó, y vuelve imposible saber si una fila la puso el usuario o un
  release. Transformar datos que YA están (renombrar una tool, mover una columna)
  sí es trabajo de una migración. La numeración tiene huecos por las seeds
  borradas y los números **no se reutilizan**: una base vieja los tiene en
  `schema_migrations` y se saltearía la migración nueva.
- **Logs:** siempre `createLogger('scope')` — no `console.log`.
- **Errores:** valida en el borde (Zod). No agregar try/catch defensivo en código interno.
- **Inyección:** las clases de `application/` reciben sus ports por constructor. Importar
  `container.js` desde dentro de una clase es service locator — no lo hagas en código nuevo.
- **Tests colocados:** `foo.ts` + `foo.test.ts` (server, `bun:test`) / `Foo.vue` + `Foo.spec.ts`
  (web, Vitest). Nunca una carpeta `__tests__` paralela.

## Subagents disponibles

Definidos en `.claude/agents/`:

- `architecture-guardian` — audita fronteras de capas y modularidad. Úsalo antes de commit
  cuando el cambio agrega archivos, carpetas o imports entre capas.
- `server-verifier` — corre tests + typecheck del server; úsalo al terminar cambios en `apps/server/**`.
- `web-verifier` — corre `vue-tsc --noEmit` + vitest en web; úsalo al tocar `apps/web/**`.
- `feature-implementer` — feature vertical en el server (shared → port → use-case → ruta → test).
- `vue-component-builder` — componente Vue + spec dentro de su feature slice.
- `migration-writer` — genera una nueva migración SQLite consistente con las existentes.
- `shared-schema-guardian` — audita cambios en `packages/shared` para asegurar compatibilidad con
  server + web, y si un símbolo nuevo debería ser editable desde `apps/web` (ver "Paridad API ↔
  front" más arriba).
- `code-reviewer`, `debugger`, `test-writer`, `pr-writer` — revisión, diagnóstico, cobertura y PRs.
  `code-reviewer` también marca campos/endpoints nuevos sin control en el front como hallazgo.

## Slash commands

- `/check` — lint + typecheck + tests de los workspaces afectados (o todos con `--all`).
- `/migrate <nombre>` — crea siguiente migración numerada + la registra en `runner.ts`.
- `/add-route <nombre>` — scaffolding de nuevo router Hono + wire en `index.ts`.

## Guardrails

- Pregunta antes de: `gh pr merge`.
- Denegado por default: leer `.env*`, `rm -rf`.

## Cosas que NO hacer

- No introducir ESLint/Prettier — Biome es el único formatter/linter.
- No usar npm/pnpm/yarn — Bun es el único package manager (el `package-lock.json` en `apps/web` debe borrarse si aparece).
- No romper la numeración consecutiva de migraciones sin actualizar `runner.ts`.
- No hardcodear paths a `~/.config/ia-flow` — usa `getConfigDir()` / `IA_FLOW_DB_PATH`.
- No importar `bun:sqlite`, `fetch` ni `node:fs` desde `domain/` o `application/` — van detrás de un port.
- No instanciar clases concretas fuera de `composition/container.ts`.
- No crear `utils/`, `helpers/`, `common/` ni `misc/` — el código va en su dominio.
- No importar entre features de web (`features/a` → `features/b`) — sube a `ui/`, `composables/` o `@ia-flow/shared`.
- No duplicar tipos de red en la app — si cruza el wire, vive en `packages/shared`.
