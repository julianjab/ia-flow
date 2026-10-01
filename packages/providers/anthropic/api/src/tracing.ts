/**
 * Qué deja `AnthropicProvider` en la traza — lo usan los decorators de `AnthropicProvider.ts`, así
 * el loop de tools no mezcla spans con la lógica. Convenciones GenAI de OpenTelemetry (`gen_ai.*`),
 * las que Datadog/Grafana ya saben leer.
 */
import type { Tool } from '@ia-flow/agent-engine'
import {
  isLogLevelEnabled,
  type Logger,
  MAX_ATTRIBUTE_LENGTH,
  markError,
  redactSecrets,
  SpanKind,
  type TraceOptions,
  truncate,
} from '@ia-flow/telemetry'
import {
  AnthropicApiError,
  type AnthropicContentBlock,
  type AnthropicMessagesResponse,
  type AnthropicSendOptions,
} from './AnthropicClient.js'
import type {
  AnthropicMessage,
  AnthropicProvider,
  ChatRequest,
  ToolResultBlock,
} from './AnthropicProvider.js'

const scope = '@ia-flow/provider-anthropic-api'

/** Tope de un volcado de debug por atributo: generoso, pero bajo el límite de línea de Loki
 *  (256 KB) para que un turno enorme no se pierda entero. */
const DEBUG_DUMP_LENGTH = 200_000

/** Los `type` de unos bloques en orden, con las repeticiones seguidas comprimidas:
 *  `thinking,text,mcp_tool_use×2,mcp_tool_result×2`. Es lo que dice si un turno termina en
 *  `thinking` o deja una tool sin su result — sin copiar el contenido. */
export function describeBlocks(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === 'string' ? 'text' : typeof content
  const runs: Array<{ type: string; count: number }> = []
  for (const block of content) {
    const type = String((block as { type?: unknown } | null)?.type ?? '?')
    const last = runs.at(-1)
    if (last?.type === type) last.count++
    else runs.push({ type, count: 1 })
  }
  return runs.map(({ type, count }) => (count > 1 ? `${type}×${count}` : type)).join(',')
}

/** La forma de la conversación que se manda — `0:user[text] 1:assistant[thinking,tool_use]` —
 *  para leer un 400 que cita `messages.N` sin volcar los mensajes. */
export function describeConversation(messages: AnthropicMessage[]): string {
  return messages
    .map((message, index) => `${index}:${message.role}[${describeBlocks(message.content)}]`)
    .join(' ')
}

/** Recorta por el medio: un 400 puede citar el primer mensaje o el último, y los dos quedan. */
function clipMiddle(text: string, max = MAX_ATTRIBUTE_LENGTH): string {
  if (text.length <= max) return text
  const half = Math.floor((max - 20) / 2)
  return `${text.slice(0, half)} …(${text.length - 2 * half})… ${text.slice(-half)}`
}

/**
 * Qué se mandó, con `LOG_LEVEL=debug`: los parámetros enteros (tools, thinking, MCP, betas) y los
 * dos últimos mensajes — lo que cada vuelta agrega; los anteriores ya salieron en su vuelta. Las
 * credenciales (el `authorization_token` de cada MCP, tokens en un tool_result) van tapadas.
 */
function logRequestDump(
  log: Logger,
  body: ChatRequest,
  round: number,
  opts: AnthropicSendOptions,
): void {
  const { messages, ...params } = body
  const from = Math.max(0, messages.length - 2)
  log.debug(`anthropic request round ${round}`, {
    'ia.round': round,
    'ia.request.params': truncate(
      redactSecrets({ ...params, betas: opts.extraBetas ?? [], stream: opts.stream ?? true }),
      DEBUG_DUMP_LENGTH,
    ),
    'ia.request.messages.from': from,
    'ia.request.messages.total': messages.length,
    'ia.request.messages': truncate(redactSecrets(messages.slice(from)), DEBUG_DUMP_LENGTH),
  })
}

/** Lo que se loguea de CADA respuesta (nivel info): barato, y alcanza para reconstruir qué pasó. */
function responseAttributes(data: AnthropicMessagesResponse): Record<string, string | number> {
  const usage = (data.usage ?? {}) as Record<string, unknown>
  const attributes: Record<string, string | number> = {
    'gen_ai.response.finish_reasons': data.stop_reason ?? 'null',
    'ia.response.blocks': clipMiddle(describeBlocks(data.content)),
  }
  if (data.id) attributes['gen_ai.response.id'] = data.id
  if (data.model) attributes['gen_ai.response.model'] = data.model
  if (data._request_id) attributes['anthropic.request_id'] = data._request_id
  if (data.stop_sequence) attributes['anthropic.stop_sequence'] = data.stop_sequence
  if (data.stop_details != null) attributes['anthropic.stop_details'] = truncate(data.stop_details)
  if (typeof usage.service_tier === 'string')
    attributes['anthropic.service_tier'] = usage.service_tier
  if (usage.server_tool_use != null) {
    attributes['anthropic.usage.server_tool_use'] = truncate(usage.server_tool_use)
  }
  return attributes
}

/** Los conteos de tokens, con los nombres GenAI de OpenTelemetry. */
function usageAttributes(data: AnthropicMessagesResponse): Record<string, number> {
  const usage = (data.usage ?? {}) as Record<string, unknown>
  const tokens: Record<string, number> = {}
  for (const key of [
    'input_tokens',
    'output_tokens',
    'cache_read_input_tokens',
    'cache_creation_input_tokens',
  ]) {
    const value = usage[key]
    if (typeof value === 'number') tokens[`gen_ai.usage.${key}`] = value
  }
  return tokens
}

/**
 * Un 400 de la API sobre la conversación (`messages.N: …`) no se entiende sin su forma: queda en el
 * log junto al `request-id`, que es lo que pide soporte de Anthropic. Otros errores (red, 5xx
 * agotados) ya los loguea `@traced` tal cual.
 */
export function logRejectedRequest(
  log: Logger,
  err: unknown,
  body: ChatRequest,
  round: number,
): void {
  if (!(err instanceof AnthropicApiError) || err.status !== 400) return
  log.warn(`la API rechazó el request de la vuelta ${round}: ${err.errorMessage ?? err.message}`, {
    'ia.round': round,
    'http.response.status_code': err.status,
    ...(err.requestId ? { 'anthropic.request_id': err.requestId } : {}),
    ...(err.errorType ? { 'error.type': err.errorType } : {}),
    'ia.request.shape': clipMiddle(describeConversation(body.messages)),
  })
  if (isLogLevelEnabled('debug')) {
    log.debug(`anthropic request rechazado round ${round}`, {
      'ia.round': round,
      'ia.request.messages': truncate(redactSecrets(body.messages), DEBUG_DUMP_LENGTH),
    })
  }
}

/**
 * `chat <model>` por cada request a la API — un reintento por `max_tokens` es otro span. Lleva el
 * uso de tokens y, como eventos, lo que el modelo hizo server-side (MCP): eso no corre acá, así que
 * no tiene duración propia que medir.
 */
export const chatTrace: TraceOptions<
  AnthropicProvider,
  [ChatRequest, number, AnthropicSendOptions],
  AnthropicMessagesResponse
> = {
  name: (body) => `chat ${body.model}`,
  kind: SpanKind.CLIENT,
  scope,
  attributes(body, round, opts) {
    if (isLogLevelEnabled('debug')) logRequestDump(this.log, body, round, opts)
    const thinking = (body.thinking as { type?: unknown } | undefined)?.type
    return {
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'anthropic',
      'gen_ai.request.model': body.model,
      'gen_ai.request.max_tokens': body.max_tokens,
      'ia.round': round,
      'ia.messages': body.messages.length,
      // La forma de lo que se manda: si la API lo rechaza, el span ya la tiene.
      'ia.request.shape': clipMiddle(describeConversation(body.messages)),
      ...(typeof thinking === 'string' ? { 'ia.request.thinking': thinking } : {}),
      ...(opts.extraBetas?.length ? { 'ia.request.betas': opts.extraBetas.join(',') } : {}),
    }
  },
  onResult(span, data, _body, round) {
    const response = responseAttributes(data)
    const tokens = usageAttributes(data)
    span.setAttributes({
      ...response,
      ...tokens,
      'gen_ai.response.finish_reasons': [String(response['gen_ai.response.finish_reasons'])],
    })
    this.log.info(`chat round ${round} → ${data.stop_reason ?? 'null'}`, {
      'ia.round': round,
      ...response,
      ...tokens,
    })
    if (isLogLevelEnabled('debug')) {
      this.log.debug(`anthropic response round ${round}`, {
        'ia.round': round,
        'ia.response.content': truncate(redactSecrets(data.content), DEBUG_DUMP_LENGTH),
        'ia.response.usage': truncate(data.usage ?? {}),
      })
    }

    for (const block of data.content) {
      if (block.type === 'mcp_tool_use') {
        span.addEvent('mcp_tool_use', {
          'gen_ai.tool.name': block.name ?? '',
          'ia.mcp.server': block.server_name ?? '',
          'ia.tool.input': truncate(block.input),
        })
        this.log.info(`tool MCP "${block.server_name}.${block.name}"`, {
          'gen_ai.tool.name': block.name ?? '',
          'ia.tool.input': truncate(block.input, 500),
        })
      } else if (block.type === 'mcp_tool_result') {
        span.addEvent('mcp_tool_result', {
          'ia.tool.is_error': (block as { is_error?: boolean }).is_error === true,
          'ia.tool.result': truncate((block as { content?: unknown }).content),
        })
      } else if (block.type === 'text' && block.text) {
        span.addEvent('assistant.text', { 'ia.text': truncate(block.text) })
      }
    }
  },
}

/** `execute_tool <name>` por cada tool local que pide el modelo — en ERROR si devolvió error. */
export const toolTrace: TraceOptions<
  AnthropicProvider,
  [AnthropicContentBlock, Tool[]],
  ToolResultBlock
> = {
  name: (block) => `execute_tool ${block.name}`,
  scope,
  attributes: (block) => ({
    'gen_ai.operation.name': 'execute_tool',
    'gen_ai.tool.name': block.name ?? '',
    'gen_ai.tool.call.id': block.id ?? '',
    'ia.tool.input': truncate(block.input),
  }),
  onResult(span, result, block) {
    const name = { 'gen_ai.tool.name': block.name ?? '' }
    span.setAttribute('ia.tool.result', truncate(result.content))
    this.log.info(`tool "${block.name}"`, {
      ...name,
      'ia.tool.input': truncate(block.input, 500),
    })
    if (result.is_error) {
      markError(span, result.content)
      this.log.warn(`tool "${block.name}" devolvió error: ${truncate(result.content, 500)}`, name)
    }
  },
}
