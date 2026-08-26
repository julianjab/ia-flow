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
apps/web/              Vue 3 SPA (IA_FLOW_WEB_PORT, default 5173) — proxies /api and /ws al puerto del server
packages/shared/       Zod schemas + types, imported as @ia-flow/shared
packages/workspace/    Ciclo de vida de worktrees + provisioners (@ia-flow/workspace)
packages/github-auth/  Credenciales de GitHub: PAT / gh CLI / GitHub App (@ia-flow/github-auth)
scripts/               One-off ops scripts (GitHub Project setup, etc.)
.claude/               Agents, commands, hooks, settings for this repo
```

Cross-package dependency graph: `web → shared`, `server → shared`, `workspace → shared`,
`github-auth → shared`. `shared` has no runtime deps beyond Zod. `workspace` y `github-auth` los
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

## Credenciales de GitHub — una identidad, tres formas de conseguirla

Todo lo que este proceso habla con GitHub —la API (GraphQL/REST de `issue-sources`), git
(`WorkspaceManager`) y el MCP oficial de GitHub— usa **una sola** credencial, resuelta por
`@ia-flow/github-auth` detrás del contrato `ICredentialProvider` (`packages/shared/src/credentials.ts`).

| Modo | Identidad | Renovación | Para qué |
| --- | --- | --- | --- |
| `static` | PAT (`GITHUB_TOKEN`) | ninguna | fallback, CI, tests |
| `gh-cli` | tu usuario, vía `gh auth token` | la hace `gh` | dev local sin configurar nada |
| `github-app` | `<app>[bot]` | JWT → installation token, cada ~55' | el daemon desatendido |

`IA_FLOW_GITHUB_AUTH_MODE=auto` (default) prueba **app → gh → PAT** y se queda con la primera
*configurada* — de la identidad más específica y duradera a la más genérica. Qué estrategia ganó
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
