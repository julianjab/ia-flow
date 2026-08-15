# apps/server — Hono API + WebSockets

Bun runtime. Entry: `src/index.ts`. Puerto **3001**.

## Arquitectura — Ports & Adapters

El núcleo no conoce SQLite, ni Hono, ni Anthropic. Lo concreto entra por interfaces y se cablea
en un solo archivo.

```
src/
├── index.ts              Bootstrap: migraciones, monta routers, arranca daemon
├── daemon.ts             Ciclo de scan por proyecto + broadcast WS
├── logger.ts             Pino wrapper — usar SIEMPRE createLogger('scope')
│
├── domain/               NÚCLEO. Sin I/O, sin deps.
│   ├── ports/I*.ts         Interfaces que el núcleo necesita (ITaskRepository, IAgentProvider, ...)
│   └── errors.ts           Errores de dominio
│
├── application/          CASOS DE USO. Orquesta ports, no toca infra.
│   ├── use-cases/          Un caso de uso = una intención de negocio
│   ├── AgentOrchestrator.ts, TaskDispatcher.ts, WorkspaceManager.ts
│   └── policy.ts, branch-namer.ts, git-context.ts   (lógica pura y testeable)
│
├── infrastructure/       IMPLEMENTA ports con tecnología concreta.
│   ├── db/                 Sqlite*Repository + database.ts
│   ├── fs/ shell/ tools/ providers/ tunnel/
│
├── adapters/             SISTEMAS EXTERNOS (uno por integración).
│   └── github/ anthropic/ local/ tmux/ iterm/ terminal-base/
│
├── composition/          CABLEADO. container.ts: el ÚNICO lugar que hace `new`.
├── routes/               BORDE HTTP. Zod in → use-case/repo → JSON out.
├── migrations/           Numeradas NNN-*.ts + runner.ts (registro explícito)
│
└── (heredado, fuera del esquema) issue-managers/ agents/ tools/ variables/ slack/ config/
```

### Regla de dependencia

| Capa | Importa | NUNCA importa |
| --- | --- | --- |
| `domain/` | sólo `@ia-flow/shared` | cualquier cosa del server. Cero `bun:sqlite`, `fetch`, `node:fs`. |
| `application/` | `domain/**` | `infrastructure/**`, `adapters/**`, `composition/**` |
| `infrastructure/`, `adapters/` | `domain/**` | `application/**`, `routes/**`, `composition/**` |
| `routes/` | `application/**`, `domain/**`, `composition/container` | `infrastructure/**`, `adapters/**` directo |
| `composition/` | todo | es la hoja: sólo la importan `routes/`, `index.ts`, `daemon.ts` |

`domain/` hoy está **limpio** — mantenerlo así es la invariante más importante del repo.
Violaciones toleradas (no ampliar): `application/{AgentOrchestrator,branch-namer,provider-config,source-registry,use-cases/AssistWithAiUseCase}.ts`
importan adapters/infra; varios módulos importan `container.js` en vez de recibir sus deps;
`routes/{projects,tunnel}.ts` bajan a `infrastructure/`.

### Cómo agregar una feature (vertical, en este orden)

1. **Contrato** → schema Zod en `packages/shared/src/schemas.ts`.
2. **¿Necesita algo del mundo exterior que el núcleo no tenga?** → nuevo port en
   `domain/ports/IXxx.ts`. Declara sólo lo que el consumidor usa.
3. **Implementación** → `infrastructure/db/SqliteXxxRepository.ts` (o `adapters/<sistema>/`).
   Implementa el port, no expone nada más.
4. **Lógica de negocio** → `application/use-cases/XxxUseCase.ts`, recibiendo ports **por
   constructor**. Si no hay decisión de negocio (sólo leer y devolver), sáltate este paso.
5. **Cableado** → instancia en `composition/container.ts` y expórtala.
6. **Borde** → `routes/xxx.ts` valida con `safeParse` y llama al use-case/repo.
7. **Tests** → colocados junto a cada pieza. El use-case se testea con ports falsos escritos a
   mano (objetos literales que cumplen la interfaz), sin tocar la DB.

## Reglas

- **Imports con `.js`** aunque el archivo sea `.ts` — es ESM Bun, requerido.
- **DB path:** `getDbPath()` respeta `IA_FLOW_DB_PATH`, cae a `~/.config/ia-flow/ia-flow.sqlite`. NO hardcodear.
- **Nueva ruta:** crea `src/routes/<name>.ts` exportando `createXRouter()`. Móntalo en `index.ts` con `app.route('/api/x', createXRouter())`. Considera usar `/add-route`.
- **Nueva migración:** número consecutivo (mira el último). Archivo `NNN-descripcion.ts` exportando `up(db)`. Registra en `migrations/runner.ts`. Usa `/migrate <nombre>`.
- **Providers:** implementan `IAgentProvider` (`domain/ports/IAgentProvider.ts`) y se registran en el `ProviderRegistry` (`infrastructure/providers/`). El adapter concreto vive en `adapters/<nombre>/provider.ts`.
- **Repositorios:** una implementación por port. `SqliteXxxRepository` sólo habla SQL; nada de reglas de negocio adentro.
- **Nuevo schema cruzando red:** vive en `packages/shared`, no acá.
- **Nada de `new` fuera de `composition/container.ts`** (salvo value objects y errores).
- **Logs:** `const log = createLogger('name')` arriba del archivo. `log.info({...}, 'msg')` — objeto primero, mensaje después (convención Pino).
- **Scope de `try/catch`:** todo lo que el `catch` (o `finally`) necesite leer se declara **antes** del `try`. `const`/`let` dentro del `try` son block-scoped y quedan fuera de scope en el `catch` — TS no lo detecta y explota en runtime como `ReferenceError`, dejando la excepción original sin manejar. Regresión cubierta en `application/AgentOrchestrator.test.ts` (upstream abort).

## Daemon: webhook (default) o polling

Cada proyecto corre un `SourceIssueManager` (`issue-managers/source-issue-manager.ts`), que
define **qué** hace un ciclo de scan (fetch items → dispatch → reconciliar agentes cuyo task
se movió). Las subclases definen **cuándo**:

- `WebhookIssueManager` — **modo por defecto**. Es **push puro: no hace pull en ningún
  interval**. Escanea sólo (a) una vez al arrancar el proceso y (b) en cada delivery que
  matchea. Los deliveries se debouncean y se coalescen; el scan disparado por evento bypassa el
  cache de items del source (`getItems({ refresh: true })`). El respaldo periódico existe pero
  viene **apagado** (`IA_FLOW_WEBHOOK_FALLBACK_MS=0`) — encendelo sólo si querés red de
  seguridad mientras el hook no está configurado.
- `PollingIssueManager` — pull clásico en `IA_FLOW_POLL_INTERVAL_MS`.

**Catch-up** (`issue-managers/catch-up.ts`): son **dos** cosas distintas, no una.

- `crashRecovery` — `source.onDaemonStart()`, que limpia flags `working` de runs muertos. Sólo
  en un boot real. En `reloadManagers()` (editar un proyecto, guardar env vars, cambiar el modo)
  el daemon nunca se cayó: correrlo le arrancaría el flag a runs **en vuelo** y el siguiente
  scan lanzaría un segundo agente para la misma task.
- `initialScan` — un ciclo inmediato. En el boot, y también cuando el manager es nuevo (proyecto
  recién creado, o recién pasado a webhook): nadie más lo va a mirar hasta que llegue un
  delivery, y sin fallback timer eso puede ser nunca.

`resolveCatchUp(boot, isNew)` decide ambos, y cada uno tiene **su propia** var:
`IA_FLOW_STARTUP_SCAN=0` silencia el scan de boot (en dev el server corre con `--watch` y cada
save reinicia el proceso, así que sin eso cada save re-despacha todo lo que esté en un status
configurado), y `IA_FLOW_CRASH_RECOVERY=0` silencia la limpieza. Compartir un switch era un bug:
todo scan saltea los items con `Working=Yes`, así que apagar la limpieza junto con el scan
dejaba esas tasks trabadas para siempre — ni boot, ni reload, ni delivery las levantaba.
`IA_FLOW_STARTUP_SCAN` tampoco silencia el primer scan de un manager nuevo, que ningún reinicio
va a repetir. El daemon loguea un `warn` al bootear con cualquiera de las dos apagadas.

El daemon trackea las keys `${projectId}:${mode}` que **`buildManagers` reporta**, no
`projectRepo.list()`: los proyectos que el builder saltea (kind local, source sin
`getTransitionManager`) no tienen manager, y contarlos como gestionados les negaría el primer
scan el día que reciban un source usable.

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
| `IA_FLOW_WEBHOOK_FALLBACK_MS` | `0` (off) | Scan periódico opcional en modo webhook. `0` = sin pull. |
| `IA_FLOW_POLL_INTERVAL_MS` | `30000` | Interval del modo polling. No aplica al modo webhook. |
| `IA_FLOW_STARTUP_SCAN` | `1` | Scan al bootear. `0` lo apaga (útil con `--watch`). |
| `IA_FLOW_CRASH_RECOVERY` | `1` | Limpieza de flags `working` al bootear. `0` sólo si tus agentes sobreviven al reinicio. |

Todas se leen **lazy** (por instancia / por request), no al importar el módulo: los env vars
guardados en la DB llegan a `process.env` vía `envRepo.loadIntoProcess()`, que corre después de
los imports. Una constante a nivel de módulo los ignoraría en silencio.

Se configuran desde la UI (**General → Variables de entorno**, grupo "Daemon"), declaradas en
`routes/env-vars.ts` → `ENV_VAR_DEFINITIONS`. Ojo: `PUT /api/env-vars` **descarta claves que no
estén en ese catálogo**, así que una var nueva no se puede setear desde la UI hasta declararla
ahí. Guardar una var del grupo daemon dispara `reloadManagers()` para que el cambio de modo /
interval aplique sin reiniciar (el secreto se lee por request, no necesita reload).

**Túnel de Cloudflare** (`infrastructure/tunnel/cloudflared.ts` + `routes/tunnel.ts`): la UI
(**General → Entorno**) abre/cierra un quick tunnel (`cloudflared tunnel --url`) y muestra la
Payload URL lista para pegar en GitHub. El túnel **no** apunta al API: apunta a un proxy mínimo
(`startWebhookProxy`) que reenvía sólo `POST /api/webhooks/github` y responde 404 a todo lo
demás. La API local no tiene auth propia — `PUT /api/env-vars` sobrescribe las credenciales y
los endpoints de agentes ejecutan comandos en la máquina — así que exponerla entera por un
hostname público sería RCE para quien lo adivine. Endpoints:
`GET /api/tunnel`, `POST /api/tunnel/start`, `POST /api/tunnel/stop`; cada transición se
emite por WS como `tunnel:status`. El proceso hijo se mata en `stop()` y en el shutdown del
server; si el padre muere por SIGKILL (o por un reload de `--watch`) el hijo queda huérfano,
así que el siguiente `start()` reapea por argv exacto antes de spawnear.

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
