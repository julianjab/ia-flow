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
scripts/               One-off ops scripts (GitHub Project setup, etc.)
.claude/               Agents, commands, hooks, settings for this repo
```

Cross-package dependency graph: `web → shared`, `server → shared`. `shared` has no runtime deps beyond Zod.

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

De los candidatos habilitados que sobreviven todos, **se ejecuta el primero por `position`**.
Un dispatch corre **un** agente, no una cadena: sus outcomes (`onFinish` / `onError`) mueven el
issue al siguiente status y el próximo ciclo de scan vuelve a seleccionar contra el status nuevo.
Así avanza el pipeline sin que ningún componente conozca la cadena completa de antemano.

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

## Caps de concurrencia — cuánto corre a la vez

Cuatro scopes, un mismo criterio: **`0` o ausente = sin límite** (nunca "frenar todo" — un cap
que no puede despejarse dejaría el issue difiriéndose para siempre; para pausar un proyecto está
`polling-pause`). Los tres primeros **difieren** el issue; el de provider es el único que además
**prueba el siguiente candidato**.

| Scope | Dónde se declara | Dónde se evalúa | Qué cuenta |
| --- | --- | --- | --- |
| Proyecto | `project.settings.maxConcurrentDispatches` (UI: tab Provider) | `SourceDispatcher.atCapacity` | agentes corriendo de ese proyecto; sin valor cae a `IA_FLOW_MAX_CONCURRENT_DISPATCHES` |
| Agente | `AgentDefinition.maxConcurrentDispatches` (UI: editor de agente) | `TaskDispatcher` (pre-check barato) + `AgentOrchestrator` (autoritativo) | runs de ese agente, cruzando proyectos |
| Provider | `ProviderConfig.providerLimits[id].maxConcurrentRuns` (UI: Providers) | `resolveProvider` | runs de ese provider despachados por ESTE daemon |
| Gateway | `GATEWAY_MAX_CONCURRENT_RUNS` (env de `apps/ai-provider-gateway`) | el gateway mismo | runs en vuelo en ESE proceso |

Los conteos salen del registry de pending tasks (`capacity.ts`, puro y testeable sin I/O) — una
entrada se registra justo antes de la llamada al provider, así que un item que los gates rechazan
nunca ocupa un slot (la starvation que arregló c547c73).

**`deferred` vs `skipped`.** `TaskDispatcher.dispatch` devuelve un `DispatchOutcome`
(`@ia-flow/issue-sources`): `skipped` suelta el item (no matcheó nada, está bloqueado —
reintentar no cambia el resultado) y `deferred` lo devuelve al backlog de `SourceDispatcher`,
que lo **replaya cuando se libera un slot, sin volver a pegarle a la fuente**. Sin esa
distinción un dispatch frenado por capacidad se perdía en silencio hasta el próximo scan.

**Los dos caps de provider son distintos a propósito.** `providerLimits` es declarativo y sólo ve
lo que despachó este daemon; el gateway puede estar compartido entre varios. Por eso
`IAgentProvider.canAccept?()` (hoy sólo `RemoteAgentProvider`, contra `GET /v1/capacity`) deja
que el provider mismo diga si puede: es **consultivo y fail-open** — no reserva nada y ante
cualquier duda (404, timeout, red caída) devuelve `true`. La palabra final la tiene el gateway
en `POST /v1/run`, que responde **503** (no 500: es "volvé después", no "esto falló").

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
