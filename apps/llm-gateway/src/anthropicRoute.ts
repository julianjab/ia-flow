import { toErrorResponse } from './anthropicToOpenai.js'
import type { GatewayConfig } from './config.js'
import type { GatewayLog } from './gatewayLog.js'
import { BadRequestError } from './openaiToAnthropic.js'

/** El puerto hacia Anthropic para el formato nativo: el body ya listo → la `Response` cruda. */
export type ForwardToAnthropic = (body: Record<string, unknown>) => Promise<Response>

export interface AnthropicRouteDeps {
  config: Pick<GatewayConfig, 'defaultModel' | 'defaultMaxTokens'> &
    Partial<Pick<GatewayConfig, 'systemPrompt' | 'dropSampling' | 'logBody'>>
  forward?: ForwardToAnthropic
  log: GatewayLog
}

/** Un cliente que habla el protocolo de Anthropic: `/v1/messages`, o la ruta de chat completions
 *  (iTerm2 usa la URL configurada tal cual) con el header `anthropic-version` que sólo ellos mandan. */
export function isAnthropicRequest(request: Request, pathname: string): boolean {
  return (
    pathname === '/v1/messages' ||
    (pathname === '/v1/chat/completions' && request.headers.has('anthropic-version'))
  )
}

export const anthropicError = (message: string, type: string) => ({
  type: 'error',
  error: { type, message },
})

/** Un error del gateway con la forma de error de Anthropic. */
export function toAnthropicErrorResponse(err: unknown) {
  const { status, body } = toErrorResponse(err)
  return { status, body: anthropicError(body.error.message, body.error.type) }
}

/** Nuestro prompt y el del cliente van como DOS bloques `system`, no mezclados en un texto: el
 *  nuestro queda solo y primero. Sin `system` del cliente (ausente o vacío), sale sólo el nuestro. */
function withSystem(system: unknown, prompt: string): unknown {
  if (!prompt) return system
  if (system == null || system === '') return prompt
  if (typeof system === 'string') {
    return [
      { type: 'text', text: prompt },
      { type: 'text', text: system },
    ]
  }
  if (Array.isArray(system)) return [{ type: 'text', text: prompt }, ...system]
  return system
}

/** El body de Anthropic que llega → el que sale: el system prompt del gateway va primero, y los
 *  defaults de modelo y `max_tokens` cubren lo que el cliente omite. Pura. */
export function prepareAnthropicBody(
  incoming: unknown,
  defaults: {
    model: string
    maxTokens: number
    systemPrompt?: string
    dropSampling?: boolean
  },
): Record<string, unknown> {
  if (typeof incoming !== 'object' || incoming === null || Array.isArray(incoming)) {
    throw new BadRequestError('el body debe ser un objeto JSON')
  }
  const body = { ...(incoming as Record<string, unknown>) }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new BadRequestError('`messages` debe ser un arreglo no vacío')
  }
  body.model = body.model || defaults.model
  body.max_tokens = body.max_tokens ?? defaults.maxTokens
  const system = withSystem(body.system, defaults.systemPrompt ?? '')
  if (system !== undefined) body.system = system
  if (defaults.dropSampling) {
    body.temperature = undefined
    body.top_p = undefined
  }
  return body
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    throw new BadRequestError('el body no es JSON válido')
  }
}

const RELAYED_HEADERS = ['content-type', 'request-id', 'retry-after', 'cache-control']

/** La respuesta de Anthropic tal cual (SSE incluido), salvo que un 401/403 de SU credencial no se
 *  le muestra al cliente como si fuera el suyo: sale 502. */
async function relay(upstream: Response, log: GatewayLog): Promise<Response> {
  const credentialRejected = upstream.status === 401 || upstream.status === 403
  if (!upstream.ok) {
    log.warn(`Anthropic respondió ${upstream.status}: ${await upstream.clone().text()}`)
  }
  const headers = new Headers()
  for (const name of RELAYED_HEADERS) {
    const value = upstream.headers.get(name)
    if (value) headers.set(name, value)
  }
  return new Response(upstream.body, {
    status: credentialRejected ? 502 : upstream.status,
    headers,
  })
}

/** `(Request) → Response` para el protocolo nativo de Anthropic: reenvía con la credencial del
 *  gateway, nunca la del cliente. */
export function createAnthropicRoute(deps: AnthropicRouteDeps) {
  const { config, forward, log } = deps
  return async (request: Request): Promise<Response> => {
    if (!forward) throw new Error('el gateway no tiene un puerto de reenvío hacia Anthropic')
    const body = prepareAnthropicBody(await readJson(request), {
      model: config.defaultModel,
      maxTokens: config.defaultMaxTokens,
      systemPrompt: config.systemPrompt,
      dropSampling: config.dropSampling,
    })
    log.info(`→ ${String(body.model)} (formato Anthropic, stream=${body.stream === true})`)
    return relay(await forward(body), log)
  }
}
