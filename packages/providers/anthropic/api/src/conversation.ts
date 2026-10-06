/**
 * Cómo se arma la conversación que se le reenvía a la API, turno a turno, según la doc de server
 * tools (https://platform.claude.com/docs/en/agents-and-tools/tool-use/server-tools):
 *
 *   - Un `mcp_tool_use` sin su `mcp_tool_result` NO está roto: está PENDIENTE, y la API lo corre al
 *     principio del request siguiente. Pasa de dos maneras y en las dos el turno se reenvía tal
 *     cual: tras un `pause_turn` (la API cortó su loop server-side; se reenvía la respuesta sin
 *     nada detrás) y tras un `tool_use` local emitido junto con la llamada MCP (la API corta para
 *     que corramos lo nuestro; detrás van SÓLO los `tool_result`). Parearla con un result propio
 *     la tiraba, y ponerlo en el medio del turno dio el 400 "tool_use ids were found without
 *     tool_result blocks immediately after" de subscriptions#1763.
 *   - Un texto detrás le dice a la API que el turno terminó (la doc: "A block added after the
 *     results, such as text, tells the API that the assistant turn is over"): con una llamada
 *     pendiente, eso es un 400 ("found without a corresponding mcp_tool_result"). Por eso lo que
 *     llega mientras el agente corre espera a una vuelta sin llamadas pendientes
 *     (`awaitsServerCalls`).
 *   - Sólo una llamada que quedó CERRADA sin result —una conversación retomada de un checkpoint a
 *     la que se le sumó texto— se parea con un result de error sintético: no hay otra forma de
 *     reenviarla, y BORRARLA podía dejar `thinking` como último bloque (subscriptions#1637).
 *   - Un turno del asistente que se cierra con texto del usuario detrás (el aviso de que falta la
 *     tool terminal) no termina en `thinking`: se recortan los del final.
 */
import type { AnthropicContentBlock } from './AnthropicClient.js'
import type { AnthropicMessage } from './AnthropicProvider.js'

const UNANSWERED_MCP_CALL =
  'Esta llamada MCP quedó sin respuesta: el turno se cerró antes de que volviera. Repetila si la necesitás.'

export interface PairedMcpToolUse {
  /** Índice del mensaje del asistente en `messages`. */
  index: number
  paired: Array<{ id?: string; name?: string; server?: string }>
}

function isThinking(block: AnthropicContentBlock): boolean {
  return block.type === 'thinking' || block.type === 'redacted_thinking'
}

/** Las llamadas MCP de un turno que no tienen su result en ese mismo turno. */
function unanswered(content: AnthropicContentBlock[]): AnthropicContentBlock[] {
  const answered = new Set(
    content.filter((b) => b.type === 'mcp_tool_result').map((b) => b.tool_use_id),
  )
  return content.filter((b) => b.type === 'mcp_tool_use' && !answered.has(b.id))
}

/** Cada `mcp_tool_use` sin result, seguido de un `mcp_tool_result` de error. */
function pairContent(content: AnthropicContentBlock[]): {
  content: AnthropicContentBlock[]
  paired: AnthropicContentBlock[]
} {
  const paired = unanswered(content)
  if (paired.length === 0) return { content, paired }
  const next = content.flatMap((block) =>
    paired.includes(block)
      ? [
          block,
          {
            type: 'mcp_tool_result',
            tool_use_id: block.id,
            is_error: true,
            content: [{ type: 'text', text: UNANSWERED_MCP_CALL }],
          },
        ]
      : [block],
  )
  return { content: next, paired }
}

/** Un mensaje del usuario que trae SÓLO resultados de tools: el turno del asistente sigue abierto. */
function onlyToolResults(message: AnthropicMessage | undefined): boolean {
  return (
    message?.role === 'user' &&
    Array.isArray(message.content) &&
    message.content.length > 0 &&
    (message.content as AnthropicContentBlock[]).every((block) => block.type === 'tool_result')
  )
}

/** Si el turno del asistente en `index` sigue abierto: es el último mensaje (un `pause_turn`) o
 *  lo siguen sólo los `tool_result` de sus tools locales. Sus llamadas MCP las corre la API. */
function stillOpen(messages: AnthropicMessage[], index: number): boolean {
  return index === messages.length - 1 || onlyToolResults(messages[index + 1])
}

/**
 * Si la vuelta que está por mandarse tiene llamadas MCP pendientes: el último turno del asistente
 * las tiene y sólo lo siguen los `tool_result`. Entonces no se le puede sumar texto (lo cerraría).
 */
export function awaitsServerCalls(messages: AnthropicMessage[]): boolean {
  const index = messages.length - 2
  const assistant = messages[index]
  return (
    assistant?.role === 'assistant' &&
    Array.isArray(assistant.content) &&
    onlyToolResults(messages[index + 1]) &&
    unanswered(assistant.content as AnthropicContentBlock[]).length > 0
  )
}

/**
 * Suma un turno del asistente tal como lo devolvió la API (un `pause_turn`, o uno que llama
 * tools). Si el último mensaje ya es del asistente —la continuación de una pausa—, es el MISMO
 * turno: el contenido se agrega a ese mensaje.
 */
export function withAssistant(
  messages: AnthropicMessage[],
  content: AnthropicContentBlock[],
): AnthropicMessage[] {
  const last = messages.at(-1)
  if (last?.role !== 'assistant') return [...messages, { role: 'assistant', content }]
  const previous = Array.isArray(last.content)
    ? (last.content as AnthropicContentBlock[])
    : [{ type: 'text', text: String(last.content) }]
  return [...messages.slice(0, -1), { role: 'assistant', content: [...previous, ...content] }]
}

/** El contenido de una respuesta, listo para quedar en la conversación: sus llamadas MCP colgadas
 *  pareadas y sin `thinking` al final. Vacío si sólo había thinking. */
export function assistantContent(content: AnthropicContentBlock[]): AnthropicContentBlock[] {
  const paired = pairContent(content).content
  let end = paired.length
  while (end > 0 && isThinking(paired[end - 1] as AnthropicContentBlock)) end--
  return paired.slice(0, end)
}

/**
 * Antes de cada request, sobre TODA la conversación: parea las llamadas MCP que quedaron sin
 * result en un turno ya CERRADO (lo siguió texto del usuario: una conversación retomada de un
 * checkpoint). Las de un turno abierto quedan como están: la API las corre. Devuelve el mismo
 * array si no hubo nada que tocar.
 */
export function pairOrphanedMcpToolUse(
  messages: AnthropicMessage[],
  onPair?: (paired: PairedMcpToolUse) => void,
): AnthropicMessage[] {
  let sanitized: AnthropicMessage[] | undefined
  messages.forEach((message, index) => {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) return
    if (stillOpen(messages, index)) return
    const { content, paired } = pairContent(message.content as AnthropicContentBlock[])
    if (paired.length === 0) return
    sanitized ??= [...messages]
    sanitized[index] = { ...message, content }
    onPair?.({
      index,
      paired: paired.map((b) => ({ id: b.id, name: b.name, server: b.server_name })),
    })
  })
  return sanitized ?? messages
}

/** Suma un turno del asistente y, detrás, el texto del usuario. Un asistente que quedó vacío (sólo
 *  pensó) no se agrega: el texto va solo, sumado al último turno del usuario si lo hay. */
export function withAssistantThenUser(
  messages: AnthropicMessage[],
  response: AnthropicContentBlock[],
  userText: string,
): AnthropicMessage[] {
  const content = assistantContent(response)
  if (content.length > 0) {
    return [...withAssistant(messages, content), { role: 'user', content: userText }]
  }
  const last = messages.at(-1)
  if (last?.role !== 'user') return [...messages, { role: 'user', content: userText }]
  const previous = Array.isArray(last.content)
    ? last.content
    : [{ type: 'text', text: String(last.content) }]
  return [
    ...messages.slice(0, -1),
    { role: 'user', content: [...previous, { type: 'text', text: userText }] },
  ]
}
