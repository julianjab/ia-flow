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
├── issue-managers/       Ciclo de scan por proyecto: webhook (default) o polling — ver abajo
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

## Daemon: webhook (default) o polling

Cada proyecto corre un `SourceIssueManager` (`issue-managers/source-issue-manager.ts`), que
define **qué** hace un ciclo de scan (fetch items → dispatch → reconciliar agentes cuyo task
se movió). Las subclases definen **cuándo**:

- `WebhookIssueManager` — **modo por defecto**. Escanea al arrancar, en cada delivery que
  matchea, y en un interval lento de respaldo. Los deliveries se debouncean y se coalescen; el
  scan disparado por evento bypassa el cache de items del source (`getItems({ refresh: true })`).
- `PollingIssueManager` — pull clásico en `IA_FLOW_POLL_INTERVAL_MS`.

Resolución del modo (`issue-managers/daemon-mode.ts`): `project.settings.daemonMode` →
`IA_FLOW_DAEMON_MODE` → `webhook`. Acepta alias (`pull`/`pulling`/`poll` → polling,
`push` → webhook).

Endpoints (`routes/webhooks.ts`):

| Endpoint | Uso |
| --- | --- |
| `POST /api/webhooks/github` | Delivery de GitHub. Verifica `x-hub-signature-256` cuando hay `IA_FLOW_WEBHOOK_SECRET`. Responde al `ping`. |
| `POST /api/webhooks/projects/:id` | Nudge agnóstico de provider (curl, CI, automatización). Auth con `x-ia-flow-token`. |
| `GET  /api/webhooks/status` | Modo efectivo por proyecto + último evento/scan. |

Ruteo del delivery: `webhook-registry.ts` le pregunta a cada target si el evento le
corresponde, delegando en `ProjectSource.matchesWebhook?()` (GitHub compara el project node id;
para eventos de issues sólo puede filtrar por owner). Sin implementación → matchea todo. Si el
match tira error, **se escanea igual** (un scan de más es más barato que un evento perdido).

Env vars:

| Var | Default | Qué hace |
| --- | --- | --- |
| `IA_FLOW_DAEMON_MODE` | `webhook` | Modo global (`webhook` \| `polling`). |
| `IA_FLOW_WEBHOOK_SECRET` | — | Secreto compartido. Sin él, los endpoints aceptan sin verificar y loguean warning. |
| `IA_FLOW_WEBHOOK_DEBOUNCE_MS` | `1500` | Ventana para coalescer ráfagas de eventos. |
| `IA_FLOW_WEBHOOK_FALLBACK_MS` | `900000` | Red de seguridad si se pierde un delivery. `0` la desactiva. |
| `IA_FLOW_POLL_INTERVAL_MS` | `30000` | Interval del modo polling. |

Setup del webhook en GitHub: URL `https://<host>/api/webhooks/github`, content type
`application/json`, secret = `IA_FLOW_WEBHOOK_SECRET`, eventos **Projects v2 item** (y opcional
`issues` / `issue_comment`). En local hace falta un túnel (`cloudflared`, `ngrok`) — si no hay
forma de exponer el puerto, poné el proyecto en `polling`.

## Tests

```bash
bun test                            # todos
bun test src/routes/prompts.test.ts # uno
```

Los tests están **junto** al archivo bajo test (`foo.ts` + `foo.test.ts`). Usan `bun:test`.

## Al terminar cambios

Corre `/check` o directo: `bun test && bunx biome check apps/server`. Antes de PR usa el subagent `server-verifier`.
