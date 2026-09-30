/**
 * Reensambla un stream SSE de la Anthropic Messages API en la misma forma que un response
 * no-streaming (`{ content, stop_reason, usage }`) — portado de
 * `ia-flow/packages/ai-providers/src/anthropic-api/provider.ts`, sin el logging incremental de
 * MCP (este paquete no tiene logger; ver `AnthropicProviderOptions.onToolCall/onToolResult` en
 * `AnthropicProvider.ts` para observabilidad batch al final del response).
 *
 * `onDelta` (opcional) es el único hook incremental: se llama con cada `text_delta`/
 * `thinking_delta` a medida que llega, ANTES de que el response termine de reensamblarse — es
 * lo que le permite a un caller (ej. un chat) mostrar texto en vivo en vez de esperar el
 * response completo. El valor de retorno de `readAnthropicSseStream` sigue siendo el mismo
 * objeto reensamblado de siempre; `onDelta` es aparte, no lo reemplaza.
 */

export interface AnthropicStreamDelta {
  /** Índice del content block (`content[]`) al que pertenece este delta. */
  index: number
  type: 'text' | 'thinking'
  /** El fragmento nuevo — NO el acumulado hasta ahora. */
  delta: string
}

export type AnthropicDeltaHandler = (delta: AnthropicStreamDelta) => void

interface SseFrame {
  eventType: string
  data: string
}

function parseSseFrame(raw: string): SseFrame {
  let eventType = 'message'
  let data = ''
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) eventType = line.slice('event:'.length).trim()
    else if (line.startsWith('data:')) data += line.slice('data:'.length).trim()
  }
  return { eventType, data }
}

function applyMessageStart(evt: Record<string, unknown>, message: Record<string, unknown>): void {
  Object.assign(message, evt.message)
  message.content = []
}

function applyContentBlockStart(
  evt: Record<string, unknown>,
  blocks: Array<Record<string, unknown>>,
  pendingToolJson: string[],
): void {
  const idx = evt.index as number
  blocks[idx] = { ...(evt.content_block as Record<string, unknown>) }
  // Cualquier bloque que streamea su input vía `input_json_delta` arranca con `input` ya
  // presente — no sólo `tool_use` local, también `mcp_tool_use` remoto. `mcp_tool_result`
  // (calculado server-side, sin `input`) cae sin tocar.
  if ('input' in blocks[idx]) pendingToolJson[idx] = ''
}

function applyContentBlockDelta(
  evt: Record<string, unknown>,
  blocks: Array<Record<string, unknown>>,
  pendingToolJson: string[],
  onDelta: AnthropicDeltaHandler | undefined,
): void {
  const idx = evt.index as number
  const block = blocks[idx]
  const delta = evt.delta as Record<string, unknown> | undefined
  if (!block || !delta) return
  if (delta.type === 'text_delta') {
    const text = delta.text as string
    block.text = ((block.text as string) ?? '') + text
    onDelta?.({ index: idx, type: 'text', delta: text })
  } else if (delta.type === 'thinking_delta') {
    const thinking = delta.thinking as string
    block.thinking = ((block.thinking as string) ?? '') + thinking
    onDelta?.({ index: idx, type: 'thinking', delta: thinking })
  } else if (delta.type === 'signature_delta') {
    block.signature = ((block.signature as string) ?? '') + delta.signature
  } else if (delta.type === 'input_json_delta') {
    pendingToolJson[idx] = (pendingToolJson[idx] ?? '') + (delta.partial_json as string)
  }
}

function applyContentBlockStop(
  evt: Record<string, unknown>,
  blocks: Array<Record<string, unknown>>,
  pendingToolJson: string[],
): void {
  const idx = evt.index as number
  const block = blocks[idx]
  if (!block) return
  if (pendingToolJson[idx] !== undefined) {
    try {
      block.input = pendingToolJson[idx] ? JSON.parse(pendingToolJson[idx]) : {}
    } catch {
      block.input = {}
    }
  }
}

function applyMessageDelta(evt: Record<string, unknown>, message: Record<string, unknown>): void {
  if (evt.delta) Object.assign(message, evt.delta)
  if (evt.usage) message.usage = { ...(message.usage as object), ...(evt.usage as object) }
}

function applySseEvent(
  eventType: string,
  data: string,
  message: Record<string, unknown>,
  blocks: Array<Record<string, unknown>>,
  pendingToolJson: string[],
  onDelta: AnthropicDeltaHandler | undefined,
): void {
  const evt = JSON.parse(data) as Record<string, unknown>
  switch (eventType) {
    case 'message_start':
      applyMessageStart(evt, message)
      break
    case 'content_block_start':
      applyContentBlockStart(evt, blocks, pendingToolJson)
      break
    case 'content_block_delta':
      applyContentBlockDelta(evt, blocks, pendingToolJson, onDelta)
      break
    case 'content_block_stop':
      applyContentBlockStop(evt, blocks, pendingToolJson)
      break
    case 'message_delta':
      applyMessageDelta(evt, message)
      break
    case 'error':
      throw new Error(`Anthropic API stream error: ${JSON.stringify(evt.error ?? evt)}`)
    default:
      // message_stop, ping — nada que acumular.
      break
  }
}

export async function readAnthropicSseStream(
  res: Response,
  onDelta?: AnthropicDeltaHandler,
): Promise<Record<string, unknown>> {
  if (!res.body) throw new Error('Anthropic API streaming response sin body')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const message: Record<string, unknown> = { content: [] }
  const blocks: Array<Record<string, unknown>> = []
  const pendingToolJson: string[] = []

  // `onDelta` es código del CALLER corriendo adentro de este loop — a diferencia del resto de
  // `applySseEvent`, puede tirar (ej. `process.stdout.write` sobre un pipe cerrado). Sin este
  // try/finally, esa excepción salía del loop dejando el reader sin liberar y la conexión HTTP
  // abierta hasta que el GC la juntara, perdiendo además el response ya reensamblado aunque la
  // API haya respondido bien.
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const events = buffer.split('\n\n')
      buffer = events.pop() ?? ''
      for (const raw of events) {
        if (!raw.trim()) continue
        const { eventType, data } = parseSseFrame(raw)
        if (data) applySseEvent(eventType, data, message, blocks, pendingToolJson, onDelta)
      }
    }
  } catch (err) {
    await reader.cancel(err).catch(() => {})
    throw err
  } finally {
    reader.releaseLock()
  }

  message.content = blocks
  return message
}
