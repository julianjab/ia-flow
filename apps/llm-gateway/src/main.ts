import { AnthropicClient } from '@ia-flow/provider-anthropic-api'
import { createLogger } from '@ia-flow/telemetry'
import { parseConfig } from './config.js'
import { createHandler } from './handler.js'

/** El composition root: lee el entorno, arma el cliente de Anthropic y levanta el servidor. */

const log = createLogger('llm-gateway')
const config = parseConfig(process.env)

// La key va EXPLÍCITA: sin ella el cliente cae al `CLAUDE_CODE_OAUTH_TOKEN` del entorno, y este
// gateway sirve a otras apps — el token de una suscripción no es para eso.
const client = new AnthropicClient({
  apiKey: config.apiKey,
  maxRetries: 2,
  onRetry: (info) =>
    log.warn(`reintento ${info.attempt}/${info.maxRetries + 1} (${info.status ?? 'red'})`),
})

const handler = createHandler({
  config,
  log,
  send: (body, options) => client.send(body, options),
})

const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  // Un turno largo de Claude puede tardar minutos sin mandar bytes (tools, thinking).
  idleTimeout: 255,
  fetch: async (request) => {
    const startedAt = Date.now()
    const response = await handler(request)
    const { pathname } = new URL(request.url)
    log.info(`${request.method} ${pathname} → ${response.status} (${Date.now() - startedAt}ms)`)
    return response
  },
})

log.info(
  `escuchando en http://${server.hostname}:${server.port} — modelos: ${config.models.join(', ')}`,
)
