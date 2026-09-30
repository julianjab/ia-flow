# ia-flow — Claude Code guide

Orquesta agentes de IA contra repos y GitHub Projects. Monorepo Bun: un runner headless
(`apps/runner-v2`) sobre los paquetes del engine (`packages/agent-engine/*` y compañía), más la SPA
Vue y su visor Electron.

## Stack

- **Runtime:** Bun (runner + tooling), Node-compatible para Vite
- **Runner:** `apps/runner-v2` — `@ia-flow/agent-engine` + `bun:sqlite` + OpenTelemetry
- **Engine:** paquetes TypeScript **source-only** (sin build, sin `dist/`), probados con Vitest
- **Web:** Vue 3 + Vite + Pinia + Vue Router + Vitest
- **Shared:** Zod schemas + inferred types (source-only package)
- **Lint/format:** Biome (single tool, no ESLint/Prettier)
- **Tests:** Vitest (paquetes del engine, web, shared), `bun test` (runner-v2, desktop)

## Layout

```
apps/runner-v2/        Runner headless sobre @ia-flow/agent-engine: la definición en `.config/`
                       (runner.yaml + actions/ + pipelines/ + projects/) y las ejecuciones en SQLite — ver su README
apps/web/              Vue 3 SPA (IA_FLOW_WEB_PORT, default 5173) — proxies /api and /ws a IA_FLOW_SERVER_PORT
apps/desktop/          Visor Electron de la SPA
packages/agent-engine/
  core/                @ia-flow/agent-engine — el harness: eventos, pipelines, agentes, ejecuciones
  definitions/         @ia-flow/agent-engine-definitions — el modelo de definiciones y cómo se arman
  datasources/sqlite/  @ia-flow/agent-engine-datasource-sqlite — ExecutionRepository sobre SQLite
  datasources/yaml/    @ia-flow/agent-engine-datasource-yaml — YAML → definiciones
packages/providers/     los Provider del engine
  anthropic/api/       @ia-flow/provider-anthropic-api — la Messages API de Anthropic
  anthropic/cli/       @ia-flow/provider-anthropic-cli — el CLI `claude` (Claude Code)
  remote/              @ia-flow/provider-remote — un Provider en otra máquina (cliente + host HTTP)
packages/telemetry/    @ia-flow/telemetry — trazas y logs (OpenTelemetry)
packages/github/       auth/ api/ webhook/ tools/ — @ia-flow/github-{auth,api,webhook,tools}
packages/local/        fs/ shell/ workspace/ — @ia-flow/{fs-tools,shell-tools,workspace}
packages/slack/        api/ tools/ socket/ — @ia-flow/slack-{api,tools,socket}
packages/shared/       Zod schemas + types, imported as @ia-flow/shared
scripts/               One-off ops scripts (GitHub Project setup, proxy de webhooks)
.claude/               Agents, commands, hooks, settings for this repo
```

Los workspaces se declaran en el `package.json` raíz (`apps/*`, `packages/*`,
`packages/agent-engine/*`, `packages/agent-engine/datasources/*`, `packages/github/*`,
`packages/local/*`, `packages/providers/*`, `packages/providers/anthropic/*`, `packages/slack/*`) y todo se consume con `workspace:*`. `tsconfig.base.json` (raíz) es la base
que extienden los paquetes del engine.

Cross-package dependency graph:

```
runner-v2 → agent-engine, definitions, datasource-{sqlite,yaml}, provider-{anthropic-api,anthropic-cli,remote}, telemetry,
            github-{auth,api,webhook,tools}, slack-{api,tools,socket}, workspace
agent-engine          → telemetry
definitions           → agent-engine, telemetry
datasource-sqlite     → agent-engine, telemetry
datasource-yaml       → agent-engine, definitions
provider-anthropic-api → agent-engine, telemetry
provider-anthropic-cli → agent-engine, telemetry
provider-remote        → agent-engine, telemetry
github-api            → github-auth
github-tools          → agent-engine, github-api, github-auth
fs-tools, shell-tools → agent-engine
slack-tools           → agent-engine, slack-api
workspace             → agent-engine, fs-tools, shell-tools
github-auth, github-webhook, slack-api, slack-socket, telemetry → nada del monorepo (standalone)
web → shared
```

`shared` has no runtime deps beyond Zod. `agent-engine` **no** depende de ningún paquete de
infra: la flecha siempre va de la infra concreta (provider, GitHub, disco) hacia el contrato.

## Los paquetes del engine

Vinieron del repo ia-tools (antes `@ia-tools/*`). Cada uno trae su `CLAUDE.md` (guía para
trabajar en el código) y casi todos un `README.md` (el contrato de uso): **leelos antes de tocar
un paquete**. En una línea:

| Paquete | Qué hace |
| --- | --- |
| `@ia-flow/agent-engine` (`agent-engine/core`) | Harness domain-agnostic, **contrato puro sin I/O**: `DomainEvent`, `EventBus`, `Condition`, `Pipeline`, `Runnable`/`Action`/`Agent`, `Provider`, salidas de un agente (`routing/`), ejecuciones y colas por task (`engine/`) |
| `@ia-flow/agent-engine-definitions` | Valida (schemas), arma (`SourceBuilder`) y sirve en vivo (`DefinitionPipelineSource`) las definiciones de una fuente —agentes y pipelines—, vengan de donde vengan |
| `@ia-flow/agent-engine-datasource-yaml` | Traduce YAML a `SourceDocs`. Nada más: no arma entidades ni sabe de proyectos |
| `@ia-flow/agent-engine-datasource-sqlite` | `ExecutionRepository` sobre SQLite detrás del puerto `SqliteDatabase` (`bun:sqlite` o `node:sqlite`): las pausas sobreviven a un reinicio |
| `@ia-flow/provider-anthropic-api` | `Provider` de Anthropic (Messages API, tools, MCP remoto, streaming SSE, spans GenAI) — infra concreta |
| `@ia-flow/provider-anthropic-cli` | `Provider` sobre el CLI `claude` (print o tmux): las tools del agente por un MCP local, inbox y traza por hooks — infra concreta |
| `@ia-flow/provider-remote` | `Provider` en otra máquina: `RemoteProvider` (el runner) + `RemoteProviderHost` (expone cualquier provider local por HTTP); las tools del agente vuelven al runner por el sync — infra concreta |
| `@ia-flow/telemetry` | Instrumentación contra las APIs de OpenTelemetry (`createLogger`, decorators de trazas); el SDK lo registra la app |
| `@ia-flow/github-auth` | Token de GitHub: PAT / OAuth user token o GitHub App (JWT → installation token cacheado). Standalone |
| `@ia-flow/github-api` | Cliente REST/GraphQL de GitHub sobre `GithubAuth` |
| `@ia-flow/github-webhook` | Firma `x-hub-signature-256` + primitivos puros sobre payloads; produce algo con forma de `DomainEvent` sin importar el engine |
| `@ia-flow/github-tools` | Puente `github-api` ↔ `agent-engine`: las `Tool` de GitHub de un agente |
| `@ia-flow/fs-tools` | `fs_read`/`fs_list`/`fs_grep`/`fs_write`/`fs_edit`, contenidas a un `baseDir` |
| `@ia-flow/shell-tools` | `bash_run` sin shell, contra una policy allow/deny posicional |
| `@ia-flow/slack-api` | Cliente de la Web API de Slack (bot token) + el pedido de review, puro. Standalone |
| `@ia-flow/slack-socket` | Slack por Socket Mode (app token `xapp-`): recibe menciones y mensajes de hilo por WebSocket —sin URL pública ni firmas—, con ack inmediato, dedupe, filtro de bots y reconexión. Standalone |
| `@ia-flow/slack-tools` | Las `Action` de Slack de un agente: leer un hilo o un canal, publicar |
| `@ia-flow/workspace` | Clone persistente por repo + `git worktree` por task, con locks, reuso y limpieza; lo enchufa al engine |

Cómo se trabajan:

- **Source-only.** Los `exports` apuntan a `src/*.ts`; no hay `dist/`, ni `tsconfig.build.json`,
  ni paso de build. Un cambio de API se ve al instante en los consumidores — corré también sus
  `typecheck`.
- **Tests en un `tests/` dentro de cada carpeta** (`src/**/tests/**/*.test.ts`, Vitest), no
  colocados ni en un árbol aparte. Nunca pegan a la red real: `fetchImpl` es inyectable.
- **Imports con extensión `.js`** (ESM, `moduleResolution: NodeNext`).
- `bun run --filter <pkg> test|typecheck` (o los atajos `bun run test:<pkg>` del `package.json`
  raíz).

Los examples de ia-tools (`examples/apps/*.ts`) **no se migraron**: siguen en ese repo,
gitignoreados. El consumidor real de los paquetes es `apps/runner-v2`.

## Arquitectura

**No son negociables para código nuevo**: son lo que permite agregar una feature sin releer todo.

- **Paquetes del engine — contrato adentro, infra afuera.** `agent-engine` es contrato puro: si
  algo no compila sin tocar la red ni el filesystem, no va ahí. Lo concreto (Anthropic, GitHub, el
  disco) vive en su propio paquete e implementa los contratos del core; ninguno de ellos se
  importa desde el core. Standalone donde se puede (`github-auth`, `github-webhook`, `telemetry`
  no arrastran el engine).
- **`apps/runner-v2` — composición, no lógica.** Lee `.config/`, registra las actions de cada
  scope y monta el engine. Qué agente corre y cuándo es dato (YAML), no código del runner.
- **`apps/web` — Feature-sliced.** El código se agrupa por **dominio de negocio**
  (`features/agents/`, `features/tasks/`), no por tipo de archivo. Cada feature trae su
  `api.ts`, su `store.ts` y sus componentes juntos.
- **`packages/shared` — Contract-only.** Es la frontera con la web. Sin lógica, sin I/O. Excepción
  deliberada: `src/cache.ts` (el decorator `@memoize`, ver más abajo) — es una utilidad genérica
  sin estado de dominio ni I/O propio, no una regla de negocio.

## Cache transversal — `@memoize`

`@ia-flow/shared` (`src/cache.ts`) expone un decorator de método genérico para memoizar
resultados por instancia, en vez de armar a mano un `Map<key, {value, at}>` junto a la clase.

```ts
import { memoize, invalidateMemoized, peekMemoized } from '@ia-flow/shared'

class GitHubProjectSource {
  @memoize({ ttlMs: 5 * 60_000, key: () => 'meta', bypass: (opts) => opts?.refresh === true })
  private loadMeta(opts?: { refresh?: boolean }) { /* ... */ }
}
```

- **Storage por instancia** (`WeakMap` keyed por `this`) — dos instancias de la misma clase no
  comparten cache, y muere con la instancia sin necesidad de teardown manual.
- **`ttlMs`** — default: para siempre (hasta invalidar). **`key`** — default:
  `JSON.stringify(args)`; usa una key constante (`() => 'algo'`) cuando el método tiene un flag
  tipo `refresh` que NO debería partir el cache en entradas separadas. **`bypass`** — cuándo
  saltar la lectura del cache sin dejar de repoblarlo.
- **Promesas en vuelo se comparten**: dos llamadas concurrentes a un método async decorado
  dedupean sobre la misma promesa pendiente. Un `reject` no se cachea.
- **`invalidateMemoized(instance, methodName?)`** — dropea un método o toda la instancia.
  **`peekMemoized(instance, methodName, key)`** — lectura sync de una entrada ya resuelta, para
  interfaces que no pueden volverse `async`.
- Requiere `experimentalDecorators: true` en el `tsconfig.json` de cualquier paquete que use
  `@memoize` — Bun no aplica el reemplazo de los decorators TC39 (stage-3) en su transpiler,
  sólo el legado. Ya viene en `tsconfig.base.json` y en `shared`/`runner-v2`.

## Modularidad — reglas para que el código escale

- **Un módulo = un dominio, no un tipo de archivo.** Antes de crear `utils.ts`, `helpers.ts` o
  `common/`, pregúntate a qué dominio pertenece la función y ponla ahí. `utils.ts` es donde el
  acoplamiento se esconde.
- **Contra la duplicación, la tercera vez.** Dos usos parecidos pueden divergir; al **tercero**
  extrae la abstracción. Abstraer en el primero produce parámetros booleanos y ramas muertas.
- **Interfaces angostas.** Un port declara lo que el consumidor necesita, no todo lo que el
  proveedor sabe hacer. Si una interfaz crece a 15 métodos, probablemente son dos.
- **Límites de tamaño** (señal, no dogma): archivo TS > 400 líneas, `.vue` > 300 líneas, o
  función > 50 líneas → divide antes de terminar el cambio.
- **Sin ciclos.** Ni entre módulos ni entre workspaces: si A importa B y B importa A, extrae el
  tipo compartido al paquete que ambos ya importan (el core del engine, o `@ia-flow/shared` en la
  web).
- **Efectos en los bordes.** Lógica en funciones puras y testeables; I/O (DB, red, fs,
  `process.env`) en la capa de afuera, detrás de un puerto inyectable.

## UI de `apps/web` — mobile first, sin dejar de lado el desktop

**Antes de tocar un `.vue` o un `.css` de `apps/web`, `apps/web/DESIGN_SYSTEM.md` es lectura
obligatoria** — es la definición vigente, no una guía opcional, y `src/styles/theme.css` es su
fuente de tokens. Lo que hay que saber de memoria:

- **El CSS arranca en el teléfono.** Reglas base para mobile y `@media (min-width: …)` para
  agregar densidad en pantallas grandes. Un `max-width` nuevo hay que justificarlo: es un parche,
  y por eso siempre falta uno.
- **Tres breakpoints y ninguno más: `768` / `640` / `1100`.** 768 decide si la app es táctil
  (tab bar, sin sidebar, sheets en vez de popovers); 640 apila `etiqueta · valor`; 1100 habilita
  la segunda columna.
- **`--row-h` es grilla; `--tap-h` es blanco táctil.** Todo control presionable mide `--tap-h`
  (44px) en **cualquier** ancho — no es una concesión bajo un breakpoint. Los `input`/`textarea`
  bajan a `--fs-input` (16px absolutos) bajo 768px: menos que eso dispara el zoom de iOS.
- **Las doce reglas transversales R1–R12** del design system aplican a toda pantalla, la esté
  rediseñando alguien o no. Están al final de `DESIGN_SYSTEM.md`, junto al checklist.

Los subagentes que las hacen cumplir: `vue-component-builder` al escribir, `web-verifier` y
`code-reviewer` al revisar.

## Paridad API ↔ front

Cuando un cambio agrega o modifica algo consumible desde HTTP (endpoint, campo de schema en
`packages/shared`, config de agente/proyecto), evalúa **explícitamente** si `apps/web` necesita un
control para editarlo o verlo. Si aplica y entra en el alcance, hazlo ahí mismo; si aplica pero
no entra, crea un issue con el skill `/add-issue`; si no aplica (config interna, flag de test),
dilo en el commit/PR.

## Commands

```bash
bun install                # install everything (Bun workspaces, desde la raíz)
bun run dev                # web only (5173)
bun run runner             # runner-v2: verifica GitHub, carga y valida la definición
bun run runner:serve       # runner-v2: servidor de webhooks
bun run runner:host        # runner-v2: presta sus providers locales a otros runners (--host)
bun run build              # shared → web
bun run test               # all workspaces
bun run typecheck          # all workspaces
bun run test:<pkg>         # uno solo (p.ej. test:agent-engine, test:github-api, test:runner-v2)
bun run --filter @ia-flow/agent-engine test   # equivalente por nombre de paquete
bun run lint               # biome lint
bun run format             # biome format --write
bun run check              # biome check + typecheck + test (pre-push)
```

## Puertos

| Var | Qué mueve | Default |
| --- | --- | --- |
| `IA_FLOW_WEB_PORT` (alias: `VITE_WEB_PORT`) | puerto del dev server y del `preview` de Vite | `5173` |
| `IA_FLOW_SERVER_PORT` (alias legacy: `PORT`) | destino del proxy `/api` + `/ws` de la web | `3001` |
| `VITE_API_TARGET` | override completo del destino del proxy (host incluido) | — |

`vite.config.ts` lee el `.env` de la raíz del repo y el de `apps/web` (este último gana). La API
que la web espera la servía el `apps/server` v1, que ya no está en el repo.

**Never push without `bun run check` passing.** See [~/.claude/CLAUDE.md](@~/.claude/CLAUDE.md).

## Conventions

- **Branching:** por defecto trabajar en `main`; feature branches permitidas cuando el trabajo lo justifique.
- **Naming:** camelCase (TS), PascalCase (types/components/clases — en el engine, una clase con comportamiento por archivo), SCREAMING_SNAKE_CASE (env), snake_case (payloads / DB columns / ids de tools).
- **Imports:** runner y paquetes usan extensiones `.js` (ESM). Web usa alias `@/*`. Todo paquete del monorepo se importa por su nombre `@ia-flow/*`, nunca por path relativo entre workspaces.
- **Schemas:** todo tipo que la web consume vive en `packages/shared/src/schemas.ts` (Zod) — la web valida respuestas con `.parse()`. El input de una tool del engine se declara una vez, en zod (`SchemaTool`).
- **Logs:** `createLogger('scope')` de `@ia-flow/telemetry` — no `console.log`.
- **Errores:** valida en el borde (Zod). No agregar try/catch defensivo en código interno.
- **Tests:** paquetes del engine en `src/**/tests/` (Vitest); `apps/runner-v2/src/tests/` (`bun test`); web `Foo.vue` + `Foo.spec.ts` (Vitest).

## Subagents disponibles

Definidos en `.claude/agents/`:

- `architecture-guardian` — audita fronteras de capas y modularidad. Úsalo antes de commit
  cuando el cambio agrega archivos, carpetas o imports entre paquetes.
- `web-verifier` — corre `vue-tsc --noEmit` + vitest en web; úsalo al tocar `apps/web/**`.
- `vue-component-builder` — componente Vue + spec dentro de su feature slice.
- `shared-schema-guardian` — audita cambios en `packages/shared` y si un símbolo nuevo debería ser
  editable desde `apps/web`.
- `engine-agent-author` — agentes del engine (skill `ia-flow-agent-authoring`).
- `code-reviewer`, `debugger`, `test-writer`, `pr-writer` — revisión, diagnóstico, cobertura y PRs.

`server-verifier`, `feature-implementer` y `migration-writer` (y los comandos `/migrate` y
`/add-route`) describen el `apps/server` v1, que ya no existe: no los uses hasta que se
reescriban.

## Slash commands

- `/check` — lint + typecheck + tests de los workspaces afectados (o todos con `--all`).

## Guardrails

- Pregunta antes de: `gh pr merge`.
- Denegado por default: leer `.env*`, `rm -rf`.

## Cosas que NO hacer

- No introducir ESLint/Prettier — Biome es el único formatter/linter.
- No usar npm/pnpm/yarn — Bun es el único package manager (el `package-lock.json` en `apps/web` debe borrarse si aparece). Nada de `bun link`: los paquetes del engine son workspaces de este repo.
- No agregar un paso de build ni un `dist/` a los paquetes del engine — son source-only.
- No meter I/O (red, disco, `bun:sqlite`) en `packages/agent-engine/core` — va en un paquete de infra.
- No crear `utils/`, `helpers/`, `common/` ni `misc/` — el código va en su dominio.
- No importar entre features de web (`features/a` → `features/b`) — sube a `ui/`, `composables/` o `@ia-flow/shared`.
- No duplicar tipos de red en la app — si cruza el wire, vive en `packages/shared`.
