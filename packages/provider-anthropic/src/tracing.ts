/**
 * Qué deja `AnthropicProvider` en la traza — lo usan los decorators de `AnthropicProvider.ts`, así
 * el loop de tools no mezcla spans con la lógica. Convenciones GenAI de OpenTelemetry (`gen_ai.*`),
 * las que Datadog/Grafana ya saben leer.
 */
import type { Tool } from '@ia-flow/agent-engine'
import { markError, SpanKind, type TraceOptions, truncate } from '@ia-flow/telemetry'
import type {
  AnthropicContentBlock,
  AnthropicMessagesResponse,
  AnthropicSendOptions,
} from './AnthropicClient.js'
import type { AnthropicProvider, ChatRequest, ToolResultBlock } from './AnthropicProvider.js'

const scope = '@ia-flow/provider-anthropic'

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
  attributes: (body, round) => ({
    'gen_ai.operation.name': 'chat',
    'gen_ai.provider.name': 'anthropic',
    'gen_ai.request.model': body.model,
    'gen_ai.request.max_tokens': body.max_tokens,
    'ia.round': round,
    'ia.messages': body.messages.length,
  }),
  onResult(span, data) {
    const usage = (data.usage ?? {}) as Record<string, unknown>
    const attributes: Record<string, number | string[]> = {
      'gen_ai.response.finish_reasons': [data.stop_reason ?? 'null'],
    }
    for (const key of [
      'input_tokens',
      'output_tokens',
      'cache_read_input_tokens',
      'cache_creation_input_tokens',
    ]) {
      const value = usage[key]
      if (typeof value === 'number') attributes[`gen_ai.usage.${key}`] = value
    }
    span.setAttributes(attributes)

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
