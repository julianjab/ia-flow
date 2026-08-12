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
