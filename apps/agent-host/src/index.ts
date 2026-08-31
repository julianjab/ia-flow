// ── Por qué el cuerpo entero vive detrás de `await import()` ──────────────
//
// `applyAgentHostEnv` vuelca el `agent-host.yaml` al entorno, y tiene que
// correr ANTES de que se evalúe cualquier módulo que toque `logger.ts` — que
// congela `LOG_LEVEL` al importarse. Un import estático del logger acá dejaría
// el nivel del YAML llegando tarde, en silencio. Es el mismo orden (y la misma
// razón) que el entrypoint del flavor `runner`.
//
// Los specifiers son literales, no interpolados: `bun build` no puede resolver
// un template literal y el bundle moriría en runtime con "Cannot find module".
//
// El `import type` sí es estático: los tipos se borran en la compilación, así
// que no evalúa el módulo.
//
//   ia-flow-agent-host                       → /app/config/agent-host.yaml, si existe
//   ia-flow-agent-host /otro/config.yaml     → ese archivo, o muere
import type { RegistrationOutcome } from './app.js'

const { applyAgentHostEnv, loadAgentHostConfig, resolveAgentHostConfigPath } = await import(
  './config.js'
)

const { path: configPath, explicit } = resolveAgentHostConfigPath(process.argv)
const config = loadAgentHostConfig(configPath, { explicit })
const envReport = config
  ? applyAgentHostEnv(config)
  : { applied: [] as string[], overriddenByEnv: [] as string[] }

const { createApp } = await import('./app.js')
const { createLogger, flushOtel, flushSinks, logFilePath } = await import('./logger.js')
const { AGENT_HOST_PROVIDER_IDS, createProvider } = await import('./providers.js')
const { registerSelf, unregisterFrom } = await import('./register.js')
const { loadState, saveState } = await import('./state.js')

const log = createLogger('agent-host')

// Lo guardado gana sobre el arranque en frío: el `agent-host.yaml` y las env
// vars valen la primera vez, y lo que el operador haya elegido en la pantalla
// es lo que manda de ahí en adelante. Las reglas de admisión son el único
// campo que llega por la config y no por el entorno — no hay forma sana de
// meter una lista de objetos en una variable.
const state = await loadState(config)

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
    // De dónde salió la config y qué de ella NO aplicó por venir pisado desde
    // el entorno. Se dice acá y no en `config.ts` porque allá el logger
    // todavía no nació con el nivel correcto.
    config: config ? configPath : null,
    configApplied: envReport.applied.length,
    configOverriddenByEnv: envReport.overriddenByEnv.length ? envReport.overriddenByEnv : undefined,
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
