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
  matchea, y en un interval de respaldo. Los deliveries se debouncean y se coalescen; el
  scan disparado por evento bypassa el cache de items del source (`getItems({ refresh: true })`).
  El respaldo es **adaptativo**: hasta que llega el primer delivery corre al ritmo de polling
  (`IA_FLOW_POLL_INTERVAL_MS`), así un proyecto sin webhook configurado no se degrada de 30s a
  15min sin que nadie se entere; recién ahí se relaja al interval lento.
- `PollingIssueManager` — pull clásico en `IA_FLOW_POLL_INTERVAL_MS`.

Resolución del modo (`issue-managers/daemon-mode.ts`): `project.settings.daemonMode` →
`IA_FLOW_DAEMON_MODE` → `webhook`. Acepta alias (`pull`/`pulling`/`poll` → polling,
`push` → webhook).

Endpoints (`routes/webhooks.ts`):

| Endpoint | Uso |
| --- | --- |
| `POST /api/webhooks/github` | Delivery de GitHub. Verifica `x-hub-signature-256` (HMAC timing-safe). Responde al `ping`. |
| `POST /api/webhooks/projects/:id` | Nudge agnóstico de provider (curl, CI, automatización). Auth con `x-ia-flow-token` (compare timing-safe). |
| `GET  /api/webhooks/status` | Modo efectivo por proyecto + último evento/scan. Read-only, sin auth (igual que el resto de la API local). |

**Los dos POST fallan cerrado**: sin `IA_FLOW_WEBHOOK_SECRET` responden `503` y no disparan
nada. Disparar un scan cuesta cuota GraphQL y puede lanzar agentes, así que no hay modo
"abierto". Al tunelizar, publicá **sólo** `/api/webhooks/github`, no el server entero.

Ruteo del delivery: `webhook-registry.ts` le pregunta a cada target si el evento le
corresponde, delegando en `ProjectSource.matchesWebhook?()` (GitHub compara el project node id;
para eventos de issues sólo puede filtrar por owner). Sin implementación → matchea todo. Si el
match tira error, **se escanea igual** (un scan de más es más barato que un evento perdido).

Env vars:

| Var | Default | Qué hace |
| --- | --- | --- |
| `IA_FLOW_DAEMON_MODE` | `webhook` | Modo global (`webhook` \| `polling`). |
| `IA_FLOW_WEBHOOK_SECRET` | — | Secreto compartido. **Obligatorio**: sin él los POST responden 503. |
| `IA_FLOW_WEBHOOK_DEBOUNCE_MS` | `1500` | Ventana para coalescer ráfagas de eventos. |
| `IA_FLOW_WEBHOOK_FALLBACK_MS` | `900000` | Red de seguridad si se pierde un delivery. `0` la desactiva. |
| `IA_FLOW_POLL_INTERVAL_MS` | `30000` | Interval del modo polling, y del respaldo pre-primer-delivery. |

Todas se leen **lazy** (por instancia / por request), no al importar el módulo: los env vars
guardados en la DB llegan a `process.env` vía `envRepo.loadIntoProcess()`, que corre después de
los imports. Una constante a nivel de módulo los ignoraría en silencio.

Se configuran desde la UI (**General → Variables de entorno**, grupo "Daemon"), declaradas en
`routes/env-vars.ts` → `ENV_VAR_DEFINITIONS`. Ojo: `PUT /api/env-vars` **descarta claves que no
estén en ese catálogo**, así que una var nueva no se puede setear desde la UI hasta declararla
ahí. Guardar una var del grupo daemon dispara `reloadManagers()` para que el cambio de modo /
interval aplique sin reiniciar (el secreto se lee por request, no necesita reload).

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
