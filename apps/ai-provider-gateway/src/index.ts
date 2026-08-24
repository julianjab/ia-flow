import { type RegistrationOutcome, createApp } from './app.js'
import { createLogger } from './logger.js'
import { GATEWAY_PROVIDER_IDS, createProvider } from './providers.js'
import { registerSelf, unregisterFrom } from './register.js'
import { loadState, saveState } from './state.js'

const log = createLogger('gateway')

// Lo guardado gana sobre el env: `GATEWAY_MAX_CONCURRENT_RUNS` y
// `IA_FLOW_REGISTER_SERVER_URLS` son el arranque en frío, y lo que el
// operador haya elegido en la pantalla es lo que manda de ahí en adelante.
const state = await loadState()

// Compartido con la app por referencia: el self-registro de abajo ocurre
// DESPUÉS de que el server esté escuchando, y así su resultado aparece en
// /v1/registrations sin que la app tenga que esperarlo.
const registrationStatus = new Map<string, RegistrationOutcome>()

// Lo elegido en la pantalla gana sobre `GATEWAY_PROVIDER`, igual que el resto
// del estado guardado.
const app = createApp({
  provider: createProvider(state.providerId ?? undefined),
  createProviderById: createProvider,
  availableProviderIds: GATEWAY_PROVIDER_IDS,
  token: Bun.env.API_AI_PROVIDER_TOKEN,
  log,
  state,
  onStateChange: saveState,
  registerTo: (serverUrls, publicUrl) => registerSelf({ log, serverUrls, publicUrl }),
  unregisterFrom: (serverUrl) => unregisterFrom(serverUrl, { log }),
  registrationStatus,
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
  },
  'ai-provider-gateway ready',
)

for (const result of await registerSelf({ log, serverUrls: state.registerServerUrls })) {
  registrationStatus.set(result.serverUrl, { ...result, at: new Date().toISOString() })
}
