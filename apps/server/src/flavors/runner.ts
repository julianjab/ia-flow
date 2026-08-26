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
import {
  anthropicApiProvider,
  broadcast,
  executionLogRepo,
  githubCredentials,
  providerRegistry,
} from '../composition/container.js'
import { startDaemon } from '../daemon.js'
import { getRunnerConfig, getRunnerEnvReport } from '../infrastructure/config/runner-config.js'
import { createLogger, flushOtel } from '../logger.js'
import { runMigrations } from '../migrations/runner.js'
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

// El volcado del YAML al entorno ya ocurrió (en main.ts, antes de que este
// módulo existiera); se loguea acá porque recién ahora el logger nació con el
// LOG_LEVEL que ese mismo volcado configuró.
log.info(getRunnerEnvReport() ?? {}, 'runner.yaml aplicado al entorno del proceso')

// El broadcast del `full` empuja a los clientes WS. Acá no hay ninguno, así
// que se deja el no-op del container: los eventos igual viajan al server
// principal por el forward de ejecuciones (`upstream` del runner.yaml).
broadcast.setFn(() => {})

await runMigrations()

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

const webhooks = createWebhooksRouter()

const port = resolveServerPort()
const server = Bun.serve({
  port,
  fetch(req) {
    const url = new URL(req.url)
    // Superficie deliberadamente mínima: el webhook y un health check. Todo
    // lo demás es 404 — la misma política que tenía el proxy standalone.
    if (url.pathname === '/health') {
      return Response.json({ ok: true, flavor: 'runner', ts: new Date().toISOString() })
    }
    if (url.pathname.startsWith('/api/webhooks')) return webhooks.fetch(req)
    return new Response('Not found', { status: 404 })
  },
})

log.info(
  {
    port,
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
