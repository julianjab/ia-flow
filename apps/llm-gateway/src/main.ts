import { AnthropicClient } from '@ia-flow/provider-anthropic-api'
import {
  addLogSink,
  consoleSink,
  createLogger,
  parseLogLevel,
  setLogLevel,
} from '@ia-flow/telemetry'
import { parseConfig } from './config.js'
import { formatAnthropicRequest } from './gatewayLog.js'
import { createHandler } from './handler.js'

/** El composition root: lee el entorno, arma el cliente de Anthropic y levanta el servidor. */

// El telemetry arranca sin sink de consola: sin esto el gateway no imprime nada.
const logLevel = parseLogLevel(process.env.LOG_LEVEL) ?? 'info'
setLogLevel(logLevel)
addLogSink(consoleSink({ level: logLevel }))

const log = createLogger('llm-gateway')
const config = parseConfig(process.env)

// El token va EXPLÍCITO, el mismo que validó `parseConfig`: el cliente no lo resuelve por su
// cuenta del entorno, donde podría encontrar otra credencial.
const client = new AnthropicClient({
  oauthToken: config.oauthToken,
  maxRetries: 2,
  onRequest: config.logBody ? (request) => log.info(formatAnthropicRequest(request)) : undefined,
  onRetry: (info) =>
    log.warn(`reintento ${info.attempt}/${info.maxRetries + 1} (${info.status ?? 'red'})`),
})

const handler = createHandler({
  config,
  log,
  send: (body, options) => client.send(body, options),
  forward: (body, options) => client.forward(body, options),
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

log.info(
  `opciones: system prompt=${config.systemPrompt ? `${config.systemPrompt.length} caracteres` : 'NO'} · drop sampling=${config.dropSampling} · log body=${config.logBody}`,
)
