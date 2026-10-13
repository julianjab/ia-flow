import type { ChatCompletionRequest, ChatMessage, ContentPart, ToolChoice } from './openaiTypes.js'

/** Un request que el gateway no puede traducir: se contesta 400 con este mensaje. */
export class BadRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BadRequestError'
  }
}

export interface TranslationDefaults {
  model: string
  maxTokens: number
  /** Va primero en `system`, antes de los system del cliente. */
  systemPrompt?: string
  /** No reenvía `temperature` ni `top_p`. */
  dropSampling?: boolean
}

type AnthropicBlock = Record<string, unknown>
interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: AnthropicBlock[]
}

const DATA_URL = /^data:([^;,]+);base64,(.+)$/s

function imageBlock(url: string): AnthropicBlock {
  const data = DATA_URL.exec(url)
  if (data) {
    return { type: 'image', source: { type: 'base64', media_type: data[1], data: data[2] } }
  }
  return { type: 'image', source: { type: 'url', url } }
}

function textOf(content: string | ContentPart[] | null | undefined): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  return content.map((part) => (part.type === 'text' ? part.text : '')).join('')
}

function blocksOf(content: string | ContentPart[] | null | undefined): AnthropicBlock[] {
  if (content == null) return []
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : []
  return content.flatMap((part): AnthropicBlock[] => {
    if (part.type === 'text') return part.text ? [{ type: 'text', text: part.text }] : []
    if (part.type === 'image_url') return [imageBlock(part.image_url.url)]
    throw new BadRequestError(`tipo de contenido no soportado: ${(part as { type: string }).type}`)
  })
}

function parseToolArguments(raw: string): unknown {
  if (!raw.trim()) return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw new BadRequestError('tool_calls[].function.arguments no es JSON válido')
  }
}

/** Anthropic exige que los `tool_result` abran el mensaje de usuario que sigue al `tool_use`, y
 *  un turno de usuario puede venir partido en varios mensajes de OpenAI: se juntan los
 *  consecutivos del mismo rol, con los resultados de tools primero. */
function pushMessage(messages: AnthropicMessage[], next: AnthropicMessage): void {
  const last = messages[messages.length - 1]
  if (!last || last.role !== next.role) {
    messages.push(next)
    return
  }
  if (next.role === 'user' && next.content[0]?.type === 'tool_result') {
    const firstFree = last.content.findIndex((block) => block.type !== 'tool_result')
    const at = firstFree === -1 ? last.content.length : firstFree
    last.content.splice(at, 0, ...next.content)
    return
  }
  last.content.push(...next.content)
}

function toAnthropicMessage(message: ChatMessage): AnthropicMessage | undefined {
  switch (message.role) {
    case 'system':
    case 'developer':
      return undefined
    case 'user': {
      const content = blocksOf(message.content)
      return content.length > 0 ? { role: 'user', content } : undefined
    }
    case 'assistant': {
      const content = [
        ...blocksOf(message.content),
        ...(message.tool_calls ?? []).map(
          (call): AnthropicBlock => ({
            type: 'tool_use',
            id: call.id,
            name: call.function.name,
            input: parseToolArguments(call.function.arguments),
          }),
        ),
      ]
      return content.length > 0 ? { role: 'assistant', content } : undefined
    }
    case 'tool':
      return {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: message.tool_call_id,
            content: textOf(message.content),
          },
        ],
      }
  }
}

function toToolChoice(choice: ToolChoice | undefined): AnthropicBlock | undefined {
  if (choice == null || choice === 'auto') return undefined
  if (choice === 'none') return { type: 'none' }
  if (choice === 'required') return { type: 'any' }
  if (typeof choice === 'object') return { type: 'tool', name: choice.function.name }
  return undefined
}

function toAnthropicMessages(request: ChatCompletionRequest): AnthropicMessage[] {
  const messages: AnthropicMessage[] = []
  for (const message of request.messages) {
    const translated = toAnthropicMessage(message)
    if (translated) pushMessage(messages, translated)
  }
  if (messages.length === 0) throw new BadRequestError('no hay mensajes de usuario ni de asistente')
  return messages
}

function toolFields(request: ChatCompletionRequest): Record<string, unknown> {
  if (!request.tools || request.tools.length === 0) return {}
  const tools = request.tools.map((tool) => ({
    name: tool.function.name,
    ...(tool.function.description ? { description: tool.function.description } : {}),
    input_schema: tool.function.parameters ?? { type: 'object', properties: {} },
  }))
  const toolChoice = toToolChoice(request.tool_choice)
  return { tools, ...(toolChoice ? { tool_choice: toolChoice } : {}) }
}

/** OpenAI acepta temperature de 0 a 2; Anthropic, de 0 a 1. */
const clampTemperature = (value: number) => Math.min(Math.max(value, 0), 1)

function samplingFields(request: ChatCompletionRequest): Record<string, unknown> {
  const stop = typeof request.stop === 'string' ? [request.stop] : request.stop
  // Hay clientes que mandan los opcionales como `null` en vez de omitirlos: `!= null`, no `!== undefined`.
  const hasTemperature = request.temperature != null
  return {
    ...(hasTemperature ? { temperature: clampTemperature(request.temperature as number) } : {}),
    // Los modelos recientes rechazan temperature y top_p juntos: gana temperature.
    ...(request.top_p != null && !hasTemperature ? { top_p: request.top_p } : {}),
    ...(stop && stop.length > 0 ? { stop_sequences: stop } : {}),
  }
}

/** El request de OpenAI → el body de la Messages API de Anthropic. Pura: no toca la red. */
export function toAnthropicRequest(
  request: ChatCompletionRequest,
  defaults: TranslationDefaults,
): Record<string, unknown> {
  if (!Array.isArray(request.messages) || request.messages.length === 0) {
    throw new BadRequestError('`messages` debe ser un arreglo no vacío')
  }
  const system = [
    defaults.systemPrompt ?? '',
    ...request.messages
      .filter((m) => m.role === 'system' || m.role === 'developer')
      .map((m) => textOf(m.content)),
  ]
    .filter(Boolean)
    .join('\n\n')

  return {
    model: request.model || defaults.model,
    max_tokens: request.max_completion_tokens ?? request.max_tokens ?? defaults.maxTokens,
    messages: toAnthropicMessages(request),
    ...(system ? { system } : {}),
    ...(defaults.dropSampling
      ? samplingFields({ ...request, temperature: undefined, top_p: undefined })
      : samplingFields(request)),
    ...toolFields(request),
  }
}
