import { type RegistrationOutcome, createApp } from './app.js'
import { createLogger, flushOtel, flushSinks, logFilePath } from './logger.js'
import { AGENT_HOST_PROVIDER_IDS, createProvider } from './providers.js'
import { registerSelf, unregisterFrom } from './register.js'
import { loadState, saveState } from './state.js'

const log = createLogger('agent-host')

// Lo guardado gana sobre el env: `AGENT_HOST_MAX_CONCURRENT_RUNS` y
// `IA_FLOW_REGISTER_SERVER_URLS` son el arranque en frío, y lo que el
// operador haya elegido en la pantalla es lo que manda de ahí en adelante.
const state = await loadState()

// Compartido con la app por referencia: el self-registro de abajo ocurre
// DESPUÉS de que el server esté escuchando, y así su resultado aparece en
// /v1/registrations sin que la app tenga que esperarlo.
const registrationStatus = new Map<string, RegistrationOutcome>()

// Lo elegido en la pantalla gana sobre `AGENT_HOST_PROVIDER`, igual que el resto
// del estado guardado.
const app = createApp({
  provider: createProvider(state.providerId ?? undefined, state.workspace),
  createProviderById: createProvider,
  availableProviderIds: AGENT_HOST_PROVIDER_IDS,
  token: Bun.env.API_AI_PROVIDER_TOKEN,
  log,
  state,
  onStateChange: saveState,
  registerTo: (serverUrls, publicUrl) => registerSelf({ log, serverUrls, publicUrl }),
  unregisterFrom: (serverUrl) => unregisterFrom(serverUrl, { log }),
  registrationStatus,
  logFile: logFilePath,
})

if (!Bun.env.API_AI_PROVIDER_TOKEN) {
  log.warn({}, 'API_AI_PROVIDER_TOKEN no configurado — todas las requests van a rechazarse con 500')
}

const PORT = Number.parseInt(Bun.env.PORT ?? '3002', 10)
const server = Bun.serve({ port: PORT, fetch: app.fetch })

log.info(
  {
    port: server.port,
    maxConcurrentRuns: state.maxConcurrentRuns,
    rules: state.admissionRules.length,
    // Sin `reposBase` un run que necesite un repo que esta máquina nunca vio
    // falla en `ensureLocalClone`. Se dice en el arranque porque es la config
    // que más seguido falta, y ahora se arregla desde la consola sin tocar
    // el .env ni reiniciar.
    reposBase: state.workspace.reposBase,
    // Dicho en el arranque porque el caso que motiva el archivo es
    // justamente el que no ve esta línea: la app de Electron abierta desde
    // el Finder. Quien SÍ la ve, sabe adónde mandar a mirar.
    logFile: logFilePath,
  },
  'agent-host ready',
)

// ── Apagado ordenado ──────────────────────────────────────────────────────
//
// Vive acá y NO en logger.ts: quien arranca el proceso es quien decide cómo se
// apaga. Un `process.exit()` disparado desde el módulo de logging sería
// incondicional y se llevaría puesto todo lo que se agregue después.
//
// Lo que hay que vaciar antes de salir son los tres sinks, y no son iguales:
// los dos locales son SonicBoom con `sync: false` (flush síncrono), y el de
// OTel exporta por HTTP en batches (flush asíncrono). Sin esperar a este
// último se pierde la última tanda — justo las líneas del apagado.
const SHUTDOWN_FLUSH_TIMEOUT_MS = 1_000

let shuttingDown = false

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  // Un segundo SIGTERM (o el SIGINT de quien se impacienta) no reinicia el
  // apagado: lo acelera saliendo de una.
  if (shuttingDown) process.exit(1)
  shuttingDown = true

  log.info({ signal }, 'apagando')
  server.stop()

  // Acotado: con el collector inalcanzable, `forceFlush()` arrastra el timeout
  // de OTLP más su backoff y se comería el grace del SIGTERM — llevándose
  // puesto el flush de los sinks locales, que son los que sí van a leerse.
  await Promise.race([
    flushOtel(),
    new Promise<void>((resolve) => {
      setTimeout(resolve, SHUTDOWN_FLUSH_TIMEOUT_MS).unref?.()
    }),
  ])
  flushSinks()

  // 128 + n es la convención de un proceso terminado por señal. Salir con 0
  // haría que un orquestador lea un `docker stop` como salida limpia y no
  // pueda distinguirlo de un proceso que terminó su trabajo.
  process.exit(signal === 'SIGINT' ? 130 : 143)
}

// Se registran ANTES del self-registro de abajo, que hace HTTP contra servers
// que pueden estar caídos y tarda. Un `docker stop` en esa ventana encontraría
// al proceso sin handlers y lo mataría con el comportamiento default — o sea
// sin flush y con el código equivocado, que es justo lo que esto arregla.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void shutdown(signal))
}

for (const result of await registerSelf({ log, serverUrls: state.registerServerUrls })) {
  registrationStatus.set(result.serverUrl, { ...result, at: new Date().toISOString() })
}
