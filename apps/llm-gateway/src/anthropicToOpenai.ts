import type {
  AnthropicContentBlock,
  AnthropicMessagesResponse,
} from '@ia-flow/provider-anthropic-api'
import { AnthropicApiError } from '@ia-flow/provider-anthropic-api'
import { BadRequestError } from './openaiToAnthropic.js'
import type { FinishReason, ToolCall, Usage } from './openaiTypes.js'

export interface CompletionMeta {
  id: string
  model: string
  created: number
}

export function finishReason(stopReason: AnthropicMessagesResponse['stop_reason']): FinishReason {
  switch (stopReason) {
    case 'tool_use':
      return 'tool_calls'
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'length'
    case 'refusal':
      return 'content_filter'
    default:
      return 'stop'
  }
}

export function usageOf(response: AnthropicMessagesResponse): Usage {
  const usage = response.usage ?? {}
  const num = (key: string) => (typeof usage[key] === 'number' ? (usage[key] as number) : 0)
  // Con prompt caching, `input_tokens` no incluye lo leído ni lo escrito en cache.
  const prompt =
    num('input_tokens') + num('cache_read_input_tokens') + num('cache_creation_input_tokens')
  const completion = num('output_tokens')
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion }
}

export function textOfBlocks(content: AnthropicContentBlock[]): string {
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
}

export function toolCallsOfBlocks(content: AnthropicContentBlock[]): ToolCall[] {
  return content
    .filter((block) => block.type === 'tool_use')
    .map((block) => ({
      id: block.id ?? '',
      type: 'function' as const,
      function: { name: block.name ?? '', arguments: JSON.stringify(block.input ?? {}) },
    }))
}

/** La respuesta completa de Anthropic → un `chat.completion` de OpenAI. */
export function toChatCompletion(response: AnthropicMessagesResponse, meta: CompletionMeta) {
  const toolCalls = toolCallsOfBlocks(response.content)
  return {
    id: meta.id,
    object: 'chat.completion',
    created: meta.created,
    model: response.model ?? meta.model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: textOfBlocks(response.content) || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finishReason(response.stop_reason),
      },
    ],
    usage: usageOf(response),
  }
}

function chunk(meta: CompletionMeta, delta: Record<string, unknown>, reason: FinishReason | null) {
  return {
    id: meta.id,
    object: 'chat.completion.chunk',
    created: meta.created,
    model: meta.model,
    choices: [{ index: 0, delta, finish_reason: reason }],
  }
}

export const roleChunk = (meta: CompletionMeta) =>
  chunk(meta, { role: 'assistant', content: '' }, null)

export const contentChunk = (meta: CompletionMeta, text: string) =>
  chunk(meta, { content: text }, null)

export const toolCallsChunk = (meta: CompletionMeta, calls: ToolCall[]) =>
  chunk(meta, { tool_calls: calls.map((call, index) => ({ index, ...call })) }, null)

export const finalChunk = (meta: CompletionMeta, reason: FinishReason) => chunk(meta, {}, reason)

/** El chunk de uso que OpenAI manda al final cuando el cliente pide `include_usage`. */
export const usageChunk = (meta: CompletionMeta, usage: Usage) => ({
  id: meta.id,
  object: 'chat.completion.chunk',
  created: meta.created,
  model: meta.model,
  choices: [],
  usage,
})

export interface ErrorBody {
  error: { message: string; type: string; code: string | null }
}

function errorBody(message: string, type: string, code: string | null = null): ErrorBody {
  return { error: { message, type, code } }
}

/** Un error del upstream o de la traducción → el status y el body que un cliente OpenAI espera. */
export function toErrorResponse(err: unknown): { status: number; body: ErrorBody } {
  if (err instanceof BadRequestError) {
    return { status: 400, body: errorBody(err.message, 'invalid_request_error') }
  }
  if (err instanceof AnthropicApiError) {
    const message = err.errorMessage ?? err.message
    const type = err.errorType ?? 'api_error'
    if (err.status === 401 || err.status === 403) {
      return { status: 502, body: errorBody(`credencial de Anthropic rechazada: ${message}`, type) }
    }
    if (err.status === 429 || err.status === 529) {
      return { status: 429, body: errorBody(message, type, 'rate_limit_exceeded') }
    }
    const status = err.status >= 400 && err.status < 500 ? err.status : 502
    return { status, body: errorBody(message, type) }
  }
  const message = err instanceof Error ? err.message : String(err)
  return { status: 502, body: errorBody(message, 'api_error') }
}
