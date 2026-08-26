// Flavor `runner` — el engine headless, sin API.
//
// Corre el mismo daemon que `full` contra la misma selección de agentes, pero
// no monta los 24 routers, no abre WebSocket, no registra providers de
// terminal y no sondea gateways remotos. Su único endpoint HTTP es el webhook
// de GitHub.
//
// **Eso es lo que reemplaza a `apps/agent-runner/entrypoint.sh`.** Ese script
// arrancaba dos procesos —el server completo y `scripts/webhook-proxy.ts`—
// porque el proxy existía para no exponer al mundo una API sin auth propia:
// `PUT /api/env-vars` sobrescribe credenciales y los endpoints de agentes
// ejecutan comandos en la máquina. Acá **no hay API completa que esconder**,
// así que el runner ES el proxy: un proceso, sin `curl`, sin wait-loop, sin
// trap para matar al hermano.
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import {
  anthropicApiProvider,
  broadcast,
  envRepo,
  executionLogRepo,
  githubCredentials,
  providerRegistry,
  remoteProviderHealth,
} from '../composition/container.js'
import { startDaemon } from '../daemon.js'
import { getRunnerConfig, getRunnerEnvReport } from '../infrastructure/config/runner-config.js'
import { createLogger, flushOtel, initOtelSink } from '../logger.js'
import { runMigrations } from '../migrations/runner.js'
import { mountApiRoutes } from '../routes/mount.js'
import { createProviderRegistrationsRouter } from '../routes/provider-registrations.js'
import { createWebhooksRouter } from '../routes/webhooks.js'
import { resolveWebhookSecret } from '../runner/webhook-secret.js'
import { resolveServerPort } from '../server-port.js'

const log = createLogger('runner')

const cfg = getRunnerConfig()
if (!cfg) {
  // Defensa contra un import directo de este módulo: sin config, `container.ts`
  // ya se habría cableado en modo `full` (SQLite + provisioner) y el proceso
  // haría algo distinto de lo que su nombre promete.
  throw new Error('flavor runner sin runner.yaml cargado — arrancá por src/main.ts')
}

// `anthropic-api` únicamente. tmux/iterm necesitan una terminal y un daemon
// local al que entregarle tools; en un contenedor headless no existe ninguno
// de los dos. Los remotos los da de alta el health monitor, que este flavor
// no corre — un agente con `provider: remote:x` acá difiere, no falla.
providerRegistry.register(anthropicApiProvider)

// Los remotos NO se registran acá: los da de alta —y de baja— el health
// monitor según conteste su gateway. Es lo que hace posible el reparto de
// trabajo del diseño: el runner queda mínimo (sin `git`, sin el CLI de
// Claude) y lo que necesita disco o binarios corre detrás de un
// `remote:<name>`. Sin el monitor, un `provider: remote:x` no resolvería
// nunca y el issue se diferiría para siempre.
const remoteProviders = cfg.settings?.remoteProviders ?? true
const api = cfg.settings?.api ?? 'full'
if (remoteProviders) void remoteProviderHealth.start()

// El volcado del YAML al entorno ya ocurrió (en main.ts, antes de que este
// módulo existiera); se loguea acá porque recién ahora el logger nació con el
// LOG_LEVEL que ese mismo volcado configuró.
log.info(getRunnerEnvReport() ?? {}, 'runner.yaml aplicado al entorno del proceso')

// El broadcast del `full` empuja a los clientes WS. Acá no hay ninguno, así
// que se deja el no-op del container: los eventos igual viajan al server
// principal por el forward de ejecuciones (`upstream` del runner.yaml).
broadcast.setFn(() => {})

await runMigrations()

// Las env vars que el operador guardó desde Configuración viven en la SQLite
// de ESTE proceso, y hasta acá nadie las había leído: el flavor mostraba la
// pantalla (`api: full` la publica) marcando las variables como "configurada"
// mientras el proceso seguía con el env del compose. Una UI que miente es peor
// que una que no está.
//
// Va después de `applyRunnerEnv` (main.ts) y pisa lo que el runner.yaml puso:
// misma precedencia que en el flavor `full`, donde lo guardado a mano siempre
// gana. Se loguea qué claves cambió para que un valor de la UI que contradice
// al YAML no sea un misterio.
//
// Ojo con `LOG_LEVEL`: se aplica al env, pero el logger ya nació —`logger.ts`
// lo congela al importarse, y la DB no se puede leer antes de las
// migraciones—, así que guardarlo desde la UI recién vale al reiniciar. Vale
// igual en el flavor `full`; no es de este cambio.
const beforeDb = new Set(Object.keys(process.env))
const yamlApplied = new Map(
  (getRunnerEnvReport()?.applied ?? []).map((k) => [k, process.env[k]] as const),
)
envRepo.loadIntoProcess()
const overrodeYaml = [...yamlApplied].filter(([k, v]) => process.env[k] !== v).map(([k]) => k)
const addedByDb = Object.keys(process.env).filter((k) => !beforeDb.has(k))
if (overrodeYaml.length > 0 || addedByDb.length > 0) {
  log.info({ overrodeYaml, addedByDb }, 'env vars de Configuración aplicadas')
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
app.route('/api/webhooks', createWebhooksRouter())
// El self-registro de un gateway remoto. Sin esto un `provider: remote:<name>`
// es inalcanzable: el gateway arranca, intenta anunciarse y recibe 404.
// Publicá este puerto SÓLO en 127.0.0.1 — muta estado y, como el resto de esta
// API, no tiene auth propia.
if (api === 'full') {
  // Todo el set, para que `apps/web` pueda listar este runner y mirar sus
  // proyectos, agentes y ejecuciones — incluye provider-registrations.
  mountApiRoutes(app, () => {})
} else if (remoteProviders) {
  // Sin API, pero el gateway igual tiene que poder anunciarse.
  app.route('/api/provider-registrations', createProviderRegistrationsRouter())
}
app.get('/health', (c) => c.json({ ok: true, flavor: 'runner', ts: new Date().toISOString() }))
app.all('*', (c) => c.text('Not found', 404))

const port = resolveServerPort()
const server = Bun.serve({ port, fetch: app.fetch })

log.info(
  {
    port,
    api,
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
let shuttingDown = false
async function shutdown(signal: string) {
  if (shuttingDown) return
  shuttingDown = true
  log.warn({ signal }, 'shutdown pedido')

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
