/**
 * Cómo se arma la conversación que se le reenvía a la API, turno a turno. Las tres reglas salen de
 * 400 reales (portadas del engine v1, que ya los había resuelto):
 *
 *   - Un `mcp_tool_use` sin su `mcp_tool_result` (un `pause_turn` corta el loop server-side a
 *     mitad) se PAREA con un result de error sintético. Reenviarlo suelto da 400 ("found without a
 *     corresponding mcp_tool_result"); BORRARLO deja expuesto el `thinking` que lo precedía como
 *     último bloque — el 400 de subscriptions#1637 ("The final block in an assistant message cannot
 *     be `thinking`"). El result no miente: el modelo ve que esa llamada quedó sin respuesta y
 *     decide si la repite.
 *     Si el turno además llama tools locales (`tool_use`), el par va ANTES del primer `tool_use`:
 *     la API exige que cada `tool_use` sea lo último del turno, con su `tool_result` en el mensaje
 *     siguiente, y un `mcp_tool_use` que el modelo emitió después (la API corta en el `tool_use` y
 *     nunca lo corre) lo dejaba en el medio — el 400 "tool_use ids were found without tool_result
 *     blocks immediately after" de subscriptions#1763.
 *   - Un turno del asistente nunca termina en `thinking`: se recortan los bloques de thinking del
 *     final (un `end_turn` que sólo pensó, una pausa justo después de pensar).
 *   - La conversación siempre termina en un turno del usuario: con thinking, un asistente al final
 *     es un prefill y la API lo rechaza (subscriptions#1496). Tras un `pause_turn` se sigue con un
 *     "Continuá." explícito.
 */
import type { AnthropicContentBlock } from './AnthropicClient.js'
import type { AnthropicMessage } from './AnthropicProvider.js'

export const PAUSE_TURN_CONTINUE = 'Continuá.'

const UNANSWERED_MCP_CALL =
  'Esta llamada MCP quedó sin respuesta: el turno se pausó antes de que volviera. Repetila si la necesitás.'

export interface PairedMcpToolUse {
  /** Índice del mensaje del asistente en `messages`. */
  index: number
  paired: Array<{ id?: string; name?: string; server?: string }>
}

function isThinking(block: AnthropicContentBlock): boolean {
  return block.type === 'thinking' || block.type === 'redacted_thinking'
}

/** El `mcp_tool_use` sin result, seguido de su `mcp_tool_result` de error. */
function withUnanswered(block: AnthropicContentBlock): AnthropicContentBlock[] {
  return [
    block,
    {
      type: 'mcp_tool_result',
      tool_use_id: block.id,
      is_error: true,
      content: [{ type: 'text', text: UNANSWERED_MCP_CALL }],
    },
  ]
}

/** Cada `mcp_tool_use` sin result, seguido de un `mcp_tool_result` de error; los que quedaron
 *  después de un `tool_use` local, movidos antes del primero (ver arriba). */
function pairContent(content: AnthropicContentBlock[]): {
  content: AnthropicContentBlock[]
  paired: AnthropicContentBlock[]
} {
  const answered = new Set(
    content.filter((b) => b.type === 'mcp_tool_result').map((b) => b.tool_use_id),
  )
  const paired = content.filter((b) => b.type === 'mcp_tool_use' && !answered.has(b.id))
  if (paired.length === 0) return { content, paired }
  const firstLocal = content.findIndex((b) => b.type === 'tool_use')
  const late = firstLocal < 0 ? [] : paired.filter((b) => content.indexOf(b) > firstLocal)
  const next = content.flatMap((block, index) => {
    if (late.includes(block)) return []
    const own = paired.includes(block) ? withUnanswered(block) : [block]
    return index === firstLocal ? [...late.flatMap(withUnanswered), ...own] : own
  })
  return { content: next, paired }
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
 * Antes de cada request, sobre TODA la conversación: parea las llamadas MCP colgadas de cualquier
 * turno del asistente — también las de una conversación retomada de un checkpoint viejo. Devuelve
 * el mismo array si no hubo nada que tocar.
 */
export function pairOrphanedMcpToolUse(
  messages: AnthropicMessage[],
  onPair?: (paired: PairedMcpToolUse) => void,
): AnthropicMessage[] {
  let sanitized: AnthropicMessage[] | undefined
  messages.forEach((message, index) => {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) return
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
    return [...messages, { role: 'assistant', content }, { role: 'user', content: userText }]
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
