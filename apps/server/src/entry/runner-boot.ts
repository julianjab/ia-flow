// El cuerpo del engine headless: lo que corre una vez que `runner.ts` resolvió
// la config y la dejó precargada.
//
// Vive aparte del entrypoint porque ESTE archivo sí importa el container —y
// con él el logger—, y esos imports tienen que ocurrir después del volcado de
// env. Separarlos es lo que hace que ese orden sea imposible de romper por
// accidente: no hay forma de importar el cuerpo sin haber pasado por el
// entrypoint.
//
// Corre el mismo daemon que `server.ts` contra la misma selección de agentes.
// No registra providers de terminal (no hay tmux/iTerm en un headless) y
// —salvo que su config diga `api: full`— no monta los 24 routers. El
// WebSocket de logs/ejecuciones en vivo es opt-in con `settings.websocket`
// (exige `api: full`) — apagado es el default histórico: sin él, los eventos
// siguen viajando al server principal por el forward de ejecuciones
// (`upstream` del runner.yaml), como siempre.
//
// **Eso es lo que reemplaza a `apps/agent-runner/entrypoint.sh`.** Ese script
// arrancaba dos procesos —el server completo y `scripts/webhook-proxy.ts`—
// porque el proxy existía para no exponer al mundo una API sin auth propia:
// `PUT /api/env-vars` sobrescribe credenciales y los endpoints de agentes
// ejecutan comandos en la máquina. Acá **no hay API completa que esconder**,
// así que el runner ES el proxy: un proceso, sin `curl`, sin wait-loop, sin
// trap para matar al hermano.
import { listPendingTasks, removePendingTask } from '@ia-flow/agent-engine'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { reconcileOrphanedRuns } from '../adapters/pending-task-rehydrator.js'
import {
  anthropicApiProvider,
  broadcast,
  envRepo,
  executionLogRepo,
  githubCredentials,
  providerRegistry,
  remoteProviderHealth,
  slack,
} from '../composition/container.js'
import { startDaemon } from '../daemon.js'
import { createLogger, flushOtel, initOtelSink, setLogBroadcast } from '../logger.js'
import { runMigrations } from '../migrations/runner.js'
import { createApiAuthMiddleware } from '../routes/api-auth.js'
import { mountApiRoutes } from '../routes/mount.js'
import { createProviderRegistrationsRouter } from '../routes/provider-registrations.js'
import { secretEquals } from '../routes/remote-logs-logic.js'
import { createWebhooksRouter } from '../routes/webhooks.js'
import { getRunnerConfig, getRunnerEnvReport } from '../runner/config.js'
import { resolveWebhookSecret } from '../runner/webhook-secret.js'
import { resolveServerPort } from '../server-port.js'
import { installCrashGuard, resolveFatalPolicy } from './crash-guard.js'

const log = createLogger('runner')

// Igual que en el flavor `full`: declarado arriba porque el crash guard lo
// consulta y se engancha antes de que este módulo termine de evaluarse.
let shuttingDown = false

// Ningún fallo suelto mata el runner con runs en vuelo. Ver entry/crash-guard.ts.
installCrashGuard({
  listPending: listPendingTasks,
  removePending: removePendingTask,
  log,
  isShuttingDown: () => shuttingDown,
  policy: () => resolveFatalPolicy(Bun.env.IA_FLOW_FATAL_POLICY),
})

const cfg = getRunnerConfig()
if (!cfg) {
  // Defensa contra un import directo de este módulo: sin config, `container.ts`
  // ya se habría cableado como el server completo (SQLite + provisioner) y el
  // proceso haría algo distinto de lo que su nombre promete.
  throw new Error('runner-boot importado sin config cargada — arrancá por entry/runner.ts')
}

// `anthropic-api` únicamente. tmux/iterm necesitan una terminal y un daemon
// local al que entregarle tools; en un contenedor headless no existe ninguno
// de los dos. Los remotos los da de alta el health monitor, que este flavor
// no corre — un agente con `provider: remote:x` acá difiere, no falla.
providerRegistry.register(anthropicApiProvider)

// Los remotos NO se registran acá: los da de alta —y de baja— el health
// monitor según conteste su agent-host. Es lo que hace posible el reparto de
// trabajo del diseño: el runner queda mínimo (sin `git`, sin el CLI de
// Claude) y lo que necesita disco o binarios corre detrás de un
// `remote:<name>`. Sin el monitor, un `provider: remote:x` no resolvería
// nunca y el issue se diferiría para siempre.
const remoteProviders = cfg.settings?.remoteProviders ?? true
const api = cfg.settings?.api ?? 'full'
if (remoteProviders) void remoteProviderHealth.start()

// `websocket` cruza con `api`: sin los 24 routers montados no hay ejecución
// que dispare eventos para mandar por el socket, y `mountApiRoutes` es lo
// único que llama a `broadcastFn` desde una ruta. Zod no valida esta
// combinación (son dos campos hermanos del mismo objeto) — se resuelve acá,
// con un warn en vez de un throw: es una config a medias, no una imposible de
// arrancar con (el runner sigue sirviendo el webhook igual que siempre).
const websocketRequested = cfg.settings?.websocket ?? false
if (websocketRequested && api !== 'full') {
  log.warn(
    { api },
    'settings.websocket pide el WS pero settings.api no es "full" — /ws queda apagado',
  )
}
const websocket = websocketRequested && api === 'full'

// El volcado del YAML al entorno ya ocurrió (en main.ts, antes de que este
// módulo existiera); se loguea acá porque recién ahora el logger nació con el
// LOG_LEVEL que ese mismo volcado configuró.
log.info(getRunnerEnvReport() ?? {}, 'runner.yaml aplicado al entorno del proceso')

// El `Set` de clientes vive acá arriba (no en el bloque del `Bun.serve`, más
// abajo) porque `broadcast`/`setLogBroadcast` se cablean ANTES de levantar el
// server — un log durante `runMigrations()` o el fetch de credenciales de
// GitHub, unas líneas más abajo, ya debería llegar a un cliente que conectó
// rápido.
//
// Sin `settings.websocket`, `wsSet` queda vacío para siempre y `broadcastFn`
// es un JSON.stringify que nadie lee — barato, y evita un segundo branch
// (`websocket ? broadcastFn : noop`) en cada uno de los tres call sites de
// abajo.
const wsSet = new Set<{ send(data: string): void }>()
function broadcastFn(msg: object) {
  const payload = JSON.stringify(msg)
  for (const ws of wsSet) {
    try {
      ws.send(payload)
    } catch {
      wsSet.delete(ws)
    }
  }
}

if (websocket) {
  // Mismo cableado que `server-boot.ts`: `broadcast.setFn` empuja los
  // eventos de ejecución, `setLogBroadcast` espeja cada línea de log para que
  // un cliente vea el mismo detalle que el flavor `full` — sin esto el WS
  // abriría pero se quedaría mudo salvo por `{type:'connected'}`.
  broadcast.setFn(broadcastFn)
  setLogBroadcast(broadcastFn)
} else {
  // Los eventos igual viajan al server principal por el forward de
  // ejecuciones (`upstream` del runner.yaml) — este no-op sólo apaga el WS
  // local, no el resto del pipeline de logs.
  broadcast.setFn(() => {})
}

await runMigrations()

// Reconcilia las filas que quedaron abiertas del proceso anterior — mismo
// mecanismo que el flavor `full` (ver server.ts). Sin esto, cada restart deja
// la fila `execution_logs` del run anterior `pending` para siempre (sin
// `session_id`, así que se cierra sola) mientras `loadResume` igual arranca
// un run nuevo con su propio `runId` desde el checkpoint — el resultado es
// una fila huérfana más por cada restart.
{
  const { closed, kept } = await reconcileOrphanedRuns({
    executionLogRepo,
    reason: 'orphaned: runner restart before finalize',
  })
  if (closed > 0) {
    log.warn({ closed }, 'Closed orphaned execution_logs rows from previous run')
  }
  if (kept.length > 0) {
    log.warn(
      { kept: kept.map((r) => ({ id: r.id, taskId: r.taskId, session: r.sessionId })) },
      'Runs con sesión async del proceso anterior: se dejan abiertos para que su agente pueda cerrarlos',
    )
  }
}

// Las env vars que el operador guardó desde Configuración viven en la SQLite
// de ESTE proceso, y hasta acá nadie las había leído: el flavor mostraba la
// pantalla (`api: full` la publica) marcando las variables como "configurada"
// mientras el proceso seguía con el env del compose. Una UI que miente es peor
// que una que no está.
//
// Va después de `applyRunnerEnv` (main.ts) y NO pisa lo que el runner.yaml
// puso: misma precedencia que en el flavor `full`, donde el entorno del
// proceso gana. Antes era al revés —lo guardado a mano ganaba— y se invirtió
// junto con el flavor `full`: dos precedencias opuestas según el flavor es
// exactamente lo que nadie recuerda después. El YAML del deploy es entorno,
// así que un valor guardado desde la pantalla que lo contradiga queda
// esperando, y la pantalla lo marca (`savedButUnused`) en vez de fingir que
// se aplicó. Se loguea qué claves quedaron tapadas, para que un valor de la UI
// que no surte efecto no sea un misterio.
//
// Ojo con `LOG_LEVEL`: se aplica al env, pero el logger ya nació —`logger.ts`
// lo congela al importarse, y la DB no se puede leer antes de las
// migraciones—, así que guardarlo desde la UI recién vale al reiniciar. Vale
// igual en el flavor `full`; no es de este cambio.
const beforeDb = new Set(Object.keys(process.env))
envRepo.loadIntoProcess()

// Recién ahora `Bun.env` tiene el `SLACK_BOT_TOKEN` que el operador guardó en
// la DB, y ese token es el interruptor de Slack: sin este segundo vistazo las
// tools `slack_*` no se registrarían hasta que alguien vuelva a guardar la
// variable. Ver packages/slack/CLAUDE.md.
slack.sync()
const addedByDb = Object.keys(process.env).filter((k) => !beforeDb.has(k))
// Las que el YAML (o cualquier otra fuente del entorno) dejó ganar. No es un
// error: es la precedencia. Pero es lo primero que alguien busca cuando editó
// algo en la pantalla del deploy y no cambió nada.
const shadowedByEnv = envRepo.keysOverriddenByEnv()
if (addedByDb.length > 0 || shadowedByEnv.length > 0) {
  log.info({ addedByDb, shadowedByEnv }, 'env vars de Configuración aplicadas')
}

// Recién ahora el env tiene lo guardado desde Configuración, así que el sink
// OTLP puede leer su endpoint. No-op si ya se armó al importar el logger.
initOtelSink()

// El secreto del webhook se resuelve —y se persiste, si hubo que generarlo—
// antes de que el router lo lea por request.
const webhookSecret = resolveWebhookSecret()

const identity = await githubCredentials
  .getToken()
  .then(() => githubCredentials.describe())
  .catch((err) => {
    // Fail-loud: un runner desatendido que arranca sin identidad comenta y
    // pushea como anónimo (o no puede), y el fallo aparecería recién en el
    // primer dispatch, disfrazado de error del agente.
    log.error({ err }, 'no se pudieron resolver las credenciales de GitHub')
    throw err
  })

await startDaemon()

// Superficie deliberadamente mínima: dos routers y un health check; todo lo
// demás es 404, la misma política que tenía el proxy standalone.
//
// Se montan con `app.route()` y no despachando a mano por `url.pathname`:
// cada router declara sus rutas relativas (`/github`, `/`), así que sin el
// mount que les quita el prefijo, `POST /api/webhooks/github` daba 404 — el
// runner arrancaba sano y sordo, que es la peor forma de estar roto.
const app = new Hono()
if (api === 'full') app.use('*', cors({ origin: '*' }))
// El guard de la API va ANTES de CUALQUIER `app.route('/api/...')`: en Hono el
// middleware corre en orden de registro, asi que un router montado antes NUNCA
// lo ve. Con el `use` despues del mount de webhooks, `GET /api/webhooks/status`
// —unauthenticated por diseno, devuelve proyectos y targets— quedaba sin
// proteger aunque estuviera fuera de la lista de exentas. Verificado: daba 200
// sin token.
//
// La exencion es por ruta EXACTA (`/api/webhooks/github`), asi que `/status`
// ahora exige el token como el resto.
if (api === 'full') app.use('/api/*', createApiAuthMiddleware())
app.route('/api/webhooks', createWebhooksRouter())
// El self-registro de un agent-host remoto. Sin esto un `provider: remote:<name>`
// es inalcanzable: el agent-host arranca, intenta anunciarse y recibe 404.
// Publicá este puerto SÓLO en 127.0.0.1 — muta estado y, como el resto de esta
// API, no tiene auth propia.
if (api === 'full') {
  // Todo el set, para que `apps/web` pueda listar este runner y mirar sus
  // proyectos, agentes y ejecuciones — incluye provider-registrations.
  mountApiRoutes(app, () => {})
} else if (remoteProviders) {
  // Sin API, pero el agent-host igual tiene que poder anunciarse.
  app.route('/api/provider-registrations', createProviderRegistrationsRouter())
}
app.get('/health', (c) => c.json({ ok: true, flavor: 'runner', ts: new Date().toISOString() }))
app.all('*', (c) => c.text('Not found', 404))

const port = resolveServerPort()

// Fail-closed igual que `createApiAuthMiddleware`: sin `IA_FLOW_API_TOKEN`
// configurado, `/ws` no acepta NADA — no hay forma de correr este flavor con
// el socket "abierto igual". Se lee acá y no una vez arriba porque
// `envRepo.loadIntoProcess()` (unas líneas más arriba) puede haber agregado
// el token recién ahora si el operador lo guardó desde la pantalla de
// Configuración en vez del runner.yaml.
//
// Query param y no `x-ia-flow-token`/`Authorization`: un browser no puede
// mandar headers custom en el handshake de un WebSocket (`new WebSocket(url)`
// no tiene esa API), así que el resto de la API usa headers y este único
// endpoint usa `?token=`.
function wsAuthorized(req: Request): boolean {
  const secret = process.env.IA_FLOW_API_TOKEN?.trim()
  if (!secret) return false
  const provided = new URL(req.url).searchParams.get('token') ?? undefined
  return secretEquals(provided, secret)
}

const server = websocket
  ? Bun.serve({
      port,
      fetch(req, srv) {
        if (new URL(req.url).pathname === '/ws') {
          if (!wsAuthorized(req)) return new Response('Unauthorized', { status: 401 })
          const ok = srv.upgrade(req)
          return ok ? undefined : new Response('WebSocket upgrade failed', { status: 400 })
        }
        return app.fetch(req)
      },
      websocket: {
        open(ws) {
          wsSet.add(ws as unknown as { send(data: string): void })
          ws.send(JSON.stringify({ type: 'connected' }))
        },
        close(ws) {
          wsSet.delete(ws as unknown as { send(data: string): void })
        },
        message() {
          // Sin mensajes cliente→server: es un feed de sólo lectura.
        },
      },
    })
  : Bun.serve({ port, fetch: app.fetch })

log.info(
  {
    port,
    api,
    websocket,
    ws: websocket ? `ws://localhost:${port}/ws?token=***` : undefined,
    projects: cfg.projects.map((p) => p.id),
    agents: cfg.agents.length,
    github: identity,
    webhookSecret,
  },
  'runner listo — pegá el secret en el webhook del repo/org',
)

// ─── Shutdown ───────────────────────────────────────────────────────────
// Más corto que el del flavor `full`: sin providers async no hay sesiones que
// sobrevivan al proceso, así que no hay nada que soltar vivo ni que rehidratar.
async function shutdown(signal: string) {
  if (shuttingDown) return
  shuttingDown = true
  log.warn({ signal }, 'shutdown pedido')

  // Lo que quedó abierto de runs sync (donde el abort no llegó al sitio de
  // finalize) se cierra acá — mismo motivo que en el flavor `full`. Sin
  // sondear: estamos en el handler de la señal, con un grace limitado antes
  // del SIGKILL.
  try {
    const { closed } = await reconcileOrphanedRuns({
      executionLogRepo,
      reason: `orphaned: runner ${signal} before finalize`,
      probe: async () => 'unknown',
    })
    if (closed > 0)
      log.warn({ closed }, 'Closed remaining orphaned execution_logs rows on shutdown')
  } catch (err) {
    log.warn({ err }, 'Sweep during shutdown failed')
  }

  // El forward al server principal puede ser un POST en vuelo: sin este await
  // el otro lado nunca se entera de que el run cerró, y el próximo boot no
  // tiene qué reenviar porque la fila ya se cerró localmente.
  try {
    await executionLogRepo.flush?.()
  } catch (err) {
    log.warn({ err }, 'flush del execution log falló en el shutdown')
  }

  try {
    server.stop()
  } catch {}

  await flushOtel()
  setTimeout(() => process.exit(0), 200)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
