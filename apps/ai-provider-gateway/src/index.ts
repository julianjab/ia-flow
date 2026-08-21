import { createApp } from './app.js'
import { createLogger } from './logger.js'
import { createProvider } from './providers.js'

const log = createLogger('gateway')

const app = createApp({
  provider: createProvider(),
  token: Bun.env.API_AI_PROVIDER_TOKEN,
  log,
})

if (!Bun.env.API_AI_PROVIDER_TOKEN) {
  log.warn({}, 'API_AI_PROVIDER_TOKEN no configurado — todas las requests van a rechazarse con 500')
}

const PORT = Number.parseInt(Bun.env.PORT ?? '3002', 10)
const server = Bun.serve({ port: PORT, fetch: app.fetch })

log.info({ port: server.port }, 'ai-provider-gateway ready')
