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
apps/server/           Hono API + WS (port 3001) — persists to ~/.config/ia-flow/ia-flow.sqlite
apps/web/              Vue 3 SPA (port 5173) — proxies /api and /ws to :3001
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
  (`features/agents/`, `features/tunnel/`), no por tipo de archivo. Cada feature trae su
  `api.ts`, su `store.ts` y sus componentes juntos.
- **`packages/shared` — Contract-only.** Es la frontera server↔web. Sin lógica, sin I/O.

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
- `routes/projects.ts` y `routes/tunnel.ts` bajan directo a `infrastructure/`.
- Carpetas fuera del esquema, heredadas: `issue-managers/`, `agents/`, `tools/`, `variables/`,
  `slack/`, `project-sources/`, `config/`. Conceptualmente `issue-managers/` y `agents/` son
  **application**, `tools/` y `slack/` son **adapters**. No muevas nada por gusto; cuando toques
  una de esas carpetas, no la hagas más profunda ni le agregues acceso directo a DB.

Cuando modifiques un archivo que ya viola la regla, déjalo al menos igual — nunca peor.

## Cómo el engine elige un agente

**El Agent es la entidad principal del sistema.** No hay una tabla que cablee "este status corre
estos agentes": cada agente declara sus propios criterios de activación y el engine, dado un issue,
se pregunta *¿qué agente aplica acá?*.

Los cuatro filtros se evalúan en orden. En los tres primeros, **vacío = sin restricción**:

| # | Criterio | Campo | Matchea cuando |
| --- | --- | --- | --- |
| 1 | Project | `projectId` | es `null` (agente global), o coincide con el proyecto del issue |
| 2 | Repo | `repoName` | es `null`, o el nombre está dentro de `task.repos[]` |
| 3 | Status | `statusName` | es `null`, o coincide con el status actual (case-insensitive) |
| 4 | When | `when` | las condiciones evalúan `true` contra los campos del issue (`evalWhen`) |

De los candidatos habilitados que sobreviven los cuatro, **se ejecuta el primero por `position`**.
Un dispatch corre **un** agente, no una cadena: sus outcomes (`onFinish` / `onError`) mueven el
issue al siguiente status y el próximo ciclo de poll vuelve a seleccionar contra el status nuevo.
Así avanza el pipeline sin que ningún componente conozca la cadena completa de antemano.

```
SourceIssueManager.runCycle   filtra items por los statuses del proyecto
  └─ TaskDispatcher.dispatch  gates: validate, health, projectId, allowBlocked
       └─ AgentOrchestrator.runAgent
            ├─ resolveRunContext → selectAgent   ← los 4 filtros, devuelve UNO
            └─ Agent.run                          ← ciclo de vida del run
```

Piezas: `packages/agent-engine/src/agent-selection.ts` (los filtros, puro y testeable sin I/O),
`run-context.ts` (selección + layout de repos), `AgentOrchestrator.ts` (lock + cleanup).
El contrato vive en `AgentActivationSchema` / `AgentOutcomesSchema` (`packages/shared`).

Un `StatusConfig` sólo declara la etapa del pipeline: `{ name, allowBlocked, position }`.

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

## Commands

```bash
bun install                # install everything
bun run dev                # server + web in parallel
bun run dev:server         # server only (3001)
bun run dev:web            # web only (5173)
bun run build              # shared → server → web
bun run test               # all workspaces
bun run typecheck          # all workspaces
bun run lint               # biome lint
bun run format             # biome format --write
bun run check              # biome check + typecheck + test (pre-push)
```

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
- `shared-schema-guardian` — audita cambios en `packages/shared` para asegurar compatibilidad con server + web.
- `code-reviewer`, `debugger`, `test-writer`, `pr-writer` — revisión, diagnóstico, cobertura y PRs.

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
