import { createApp } from './app.js'
import { createLogger } from './logger.js'
import { createProvider } from './providers.js'
import { registerSelf } from './register.js'

const log = createLogger('gateway')

// Sin default: un gateway sin GATEWAY_MAX_CONCURRENT_RUNS acepta todo lo que
// le manden, igual que antes de que este cap existiera.
const maxConcurrentRuns = Number.parseInt(Bun.env.GATEWAY_MAX_CONCURRENT_RUNS ?? '', 10)

const app = createApp({
  provider: createProvider(),
  token: Bun.env.API_AI_PROVIDER_TOKEN,
  log,
  maxConcurrentRuns: Number.isFinite(maxConcurrentRuns) ? maxConcurrentRuns : undefined,
})

if (!Bun.env.API_AI_PROVIDER_TOKEN) {
  log.warn({}, 'API_AI_PROVIDER_TOKEN no configurado — todas las requests van a rechazarse con 500')
}

const PORT = Number.parseInt(Bun.env.PORT ?? '3002', 10)
const server = Bun.serve({ port: PORT, fetch: app.fetch })

log.info({ port: server.port }, 'ai-provider-gateway ready')

await registerSelf({ log })
