# apps/server — Hono API + WebSockets

Bun runtime. Entry: `src/index.ts`. Puerto **3001**.

## Capas

```
src/
├── index.ts              Bootstrap: registra providers, corre migraciones, monta routers, arranca daemon
├── db.ts                 bun:sqlite — tablas + helpers (repos, agents, prompts, project_settings, env_vars)
├── daemon.ts             File watcher (chokidar) + broadcast a clientes WS
├── logger.ts             Pino wrapper — usar SIEMPRE createLogger('scope')
├── migrations/           Numeradas 001-XXX + runner.ts (registro explícito)
├── routes/               Un router Hono por dominio (tasks, agents, providers, prompts, ...)
├── agents/               agent-engine.ts — ejecuta un agent definition con un provider
├── providers/            anthropic-api | tmux-claude | iterm-claude (misma interfaz)
├── issue-managers/       GitHub GraphQL + local (tareas en archivos)
├── tools/                Herramientas expuestas a los agentes (github, fs, slack)
└── slack/                Cliente Slack (permalink resolution, etc.)
```

## Reglas

- **Imports con `.js`** aunque el archivo sea `.ts` — es ESM Bun, requerido.
- **DB path:** `getDbPath()` respeta `IA_FLOW_DB_PATH`, cae a `~/.config/ia-flow/ia-flow.sqlite`. NO hardcodear.
- **Nueva ruta:** crea `src/routes/<name>.ts` exportando `createXRouter()`. Móntalo en `index.ts` con `app.route('/api/x', createXRouter())`. Considera usar `/add-route`.
- **Nueva migración:** número consecutivo (mira el último). Archivo `NNN-descripcion.ts` exportando `up(db)`. Registra en `migrations/runner.ts`. Usa `/migrate <nombre>`.
- **Providers:** implementan `AgentProvider` (ver `providers/index.ts`). Se registran en `index.ts` con `registerProvider(...)`.
- **Nuevo schema cruzando red:** vive en `packages/shared`, no acá.
- **Logs:** `const log = createLogger('name')` arriba del archivo. `log.info({...}, 'msg')` — objeto primero, mensaje después (convención Pino).
- **Scope de `try/catch`:** todo lo que el `catch` (o `finally`) necesite leer se declara **antes** del `try`. `const`/`let` dentro del `try` son block-scoped y quedan fuera de scope en el `catch` — TS no lo detecta y explota en runtime como `ReferenceError`, dejando la excepción original sin manejar. Regresión cubierta en `application/AgentOrchestrator.test.ts` (upstream abort).

## Tests

```bash
bun test                            # todos
bun test src/routes/prompts.test.ts # uno
```

Los tests están **junto** al archivo bajo test (`foo.ts` + `foo.test.ts`). Usan `bun:test`.

## Al terminar cambios

Corre `/check` o directo: `bun test && bunx biome check apps/server`. Antes de PR usa el subagent `server-verifier`.

## Permisos de agentes (issue #58)

La capacidad de cada agente se declara con un DSL propio en vez del listado plano `tools[]` + `disabledTools[]`:

- **`AgentDefinition.presetId`** — uno de `reader | refiner | implementer | reviewer | releaser` (definidos en `composition/permission-presets.ts`). Es la manera preferida para agentes nuevos.
- **`AgentDefinition.permissions[]`** — overrides sobre el preset (o el set completo si no hay preset). Cada entry es una categoría (`fs.read`, `fs.write`, `task.write`, `task.transition`, `workspace`, `bash`), un sub-scope `bash:<scope>` (`bun`, `gh`, `git.readonly`, `git.write.task`, `git.write.main`, `git.destructive`, `shell.generic`) o el escape hatch `tool:<name>`.
- **`AgentDefinition.tools[]`** — legacy. Sigue funcionando: los nombres viejos (`run_command`, `read_file`, `write_file`, …) se resuelven a los ids nuevos vía alias en el registry.

El `AgentOrchestrator` llama a `compilePolicy({ presetId, permissions })` una vez por dispatch y pasa el `CompiledPolicy` en `ProviderInput.policy → ToolContext.policy`. `bash_run` lee el whitelist (`policy.bash.bins`) y las reglas git (`policy.bash.git`) directamente del ctx — cero `if agentId === ...`. Cuando el agente no opta al DSL, `ToolContext.policy` queda `undefined` y el sandbox cae a `LEGACY_DEFAULT_POLICY` (equivalente al comportamiento pre-issue-58).

Endpoints relevantes:
- `GET /api/tools` — cada tool trae `category` y `aliases`.
- `GET /api/tools/categories` — árbol categorías/sub-scopes que renderiza la UI.
- `GET /api/permission-presets` — los 5 presets built-in.
- `POST/PUT /api/agents-crud` — acepta `presetId` y/o `permissions[]`; devuelve `warnings[]` cuando el body todavía trae `tools[]` o `disabledTools[]`.
