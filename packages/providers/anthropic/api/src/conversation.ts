/**
 * Cómo se arma la conversación que se le reenvía a la API, turno a turno, según la doc de server
 * tools (https://platform.claude.com/docs/en/agents-and-tools/tool-use/server-tools). Lo que sigue
 * habla de `mcp_tool_use`, el primer caso que dio 400, pero vale para toda llamada que corre la API
 * (ver el último punto):
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
 *   - Todo lo anterior vale igual para las server tools (`server_tool_use`): la búsqueda de tools
 *     diferidas (`tool_search_tool_regex`) espera su `tool_search_tool_result` como un
 *     `mcp_tool_use` su `mcp_tool_result`. Considerar sólo MCP dio el 400 "`tool_search_tool_regex`
 *     tool use ... without a corresponding `tool_search_tool_result`" de ai-mobile-app#824 y
 *     subscriptions#2034 (req_011Cgij7R98aeXYqRnfhLZPQ).
 */
import type { AnthropicContentBlock } from './AnthropicClient.js'
import type { AnthropicMessage } from './AnthropicProvider.js'

const UNANSWERED_MCP_CALL =
  'Esta llamada MCP quedó sin respuesta: el turno se cerró antes de que volviera. Repetila si la necesitás.'

/** Los bloques con los que el modelo pide algo que corre la API, no este proceso: una tool de un
 *  MCP del conector (`mcp_tool_use`) o una server tool (`server_tool_use`: la búsqueda de tools
 *  diferidas, web search, code execution…). Los dos esperan su result en el MISMO turno. */
const SERVER_CALLS = new Set(['mcp_tool_use', 'server_tool_use'])

/** El bloque de result de cada server tool y el `type` de su error, según la API
 *  (`Beta*ToolResultBlockParam` del SDK). Todas aceptan `error_code: 'unavailable'`. Una que no
 *  está acá no se sabe parear: se saca del turno (ver `pairContent`). */
const SERVER_TOOL_RESULTS: Record<string, { type: string; error: string }> = {
  tool_search_tool_regex: {
    type: 'tool_search_tool_result',
    error: 'tool_search_tool_result_error',
  },
  tool_search_tool_bm25: {
    type: 'tool_search_tool_result',
    error: 'tool_search_tool_result_error',
  },
  web_search: { type: 'web_search_tool_result', error: 'web_search_tool_result_error' },
  web_fetch: { type: 'web_fetch_tool_result', error: 'web_fetch_tool_result_error' },
  code_execution: { type: 'code_execution_tool_result', error: 'code_execution_tool_result_error' },
  bash_code_execution: {
    type: 'bash_code_execution_tool_result',
    error: 'bash_code_execution_tool_result_error',
  },
  text_editor_code_execution: {
    type: 'text_editor_code_execution_tool_result',
    error: 'text_editor_code_execution_tool_result_error',
  },
}

/** Una llamada server-side que quedó sin result en un turno cerrado, y qué se hizo con ella. */
export interface PairedServerCall {
  /** Índice del mensaje del asistente en `messages`. */
  index: number
  paired: Array<{ type: string; id?: string; name?: string; server?: string; dropped?: true }>
}

function isThinking(block: AnthropicContentBlock): boolean {
  return block.type === 'thinking' || block.type === 'redacted_thinking'
}

/** Las llamadas server-side de un turno que no tienen su result en ese mismo turno. Un result
 *  de la API —`mcp_tool_result`, `tool_search_tool_result`, `web_search_tool_result`…— es todo
 *  bloque del asistente que nombra una llamada con `tool_use_id`. */
function unanswered(content: AnthropicContentBlock[]): AnthropicContentBlock[] {
  const answered = new Set(
    content
      .filter((b) => b.tool_use_id != null && b.type !== 'tool_result')
      .map((b) => b.tool_use_id),
  )
  return content.filter((b) => SERVER_CALLS.has(b.type) && !answered.has(b.id))
}

/** El result de error que cierra una llamada sin respuesta, o `undefined` si es una server tool
 *  cuya forma de result no se conoce. */
function errorResult(block: AnthropicContentBlock): AnthropicContentBlock | undefined {
  if (block.type === 'mcp_tool_use') {
    return {
      type: 'mcp_tool_result',
      tool_use_id: block.id,
      is_error: true,
      content: [{ type: 'text', text: UNANSWERED_MCP_CALL }],
    }
  }
  const result = SERVER_TOOL_RESULTS[block.name ?? '']
  if (!result) return undefined
  return {
    type: result.type,
    tool_use_id: block.id,
    content: { type: result.error, error_code: 'unavailable' },
  }
}

/**
 * Cada llamada server-side sin result, seguida de un result de error. Una server tool que no se
 * sabe parear se SACA del turno: un result inventado con otra forma es otro 400, y sin result no
 * se puede reenviar. Si eso deja `thinking` al final, se recorta (subscriptions#1637).
 */
function pairContent(content: AnthropicContentBlock[]): {
  content: AnthropicContentBlock[]
  paired: AnthropicContentBlock[]
  dropped: AnthropicContentBlock[]
} {
  const paired = unanswered(content)
  if (paired.length === 0) return { content, paired, dropped: [] }
  const dropped: AnthropicContentBlock[] = []
  const next = content.flatMap((block) => {
    if (!paired.includes(block)) return [block]
    const result = errorResult(block)
    if (result) return [block, result]
    dropped.push(block)
    return []
  })
  return { content: dropped.length > 0 ? withoutTrailingThinking(next) : next, paired, dropped }
}

function withoutTrailingThinking(content: AnthropicContentBlock[]): AnthropicContentBlock[] {
  let end = content.length
  while (end > 0 && isThinking(content[end - 1] as AnthropicContentBlock)) end--
  return end === content.length ? content : content.slice(0, end)
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
 *  lo siguen sólo los `tool_result` de sus tools locales. Sus llamadas server-side las corre la
 *  API. */
function stillOpen(messages: AnthropicMessage[], index: number): boolean {
  return index === messages.length - 1 || onlyToolResults(messages[index + 1])
}

/**
 * Si la vuelta que está por mandarse tiene llamadas server-side pendientes (MCP o server tools):
 * el último turno del asistente las tiene y sólo lo siguen los `tool_result`. Entonces no se le
 * puede sumar texto (lo cerraría).
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

/** El contenido de una respuesta, listo para quedar en la conversación: sus llamadas
 *  server-side colgadas pareadas y sin `thinking` al final. Vacío si sólo había thinking. */
export function assistantContent(content: AnthropicContentBlock[]): AnthropicContentBlock[] {
  return withoutTrailingThinking(pairContent(content).content)
}

/** Lo que queda de un turno cerrado al que se le sacó todo: la API no acepta un mensaje vacío. */
const EMPTIED_TURN = '(llamada a una server tool sin respuesta, descartada)'

/**
 * Antes de cada request, sobre TODA la conversación: parea las llamadas server-side (MCP y server
 * tools) que quedaron sin result en un turno ya CERRADO (lo siguió texto del usuario: una
 * conversación retomada de un checkpoint). Las de un turno abierto quedan como están: la API las
 * corre. Devuelve el mismo array si no hubo nada que tocar.
 */
export function pairOrphanedServerCalls(
  messages: AnthropicMessage[],
  onPair?: (paired: PairedServerCall) => void,
): AnthropicMessage[] {
  let sanitized: AnthropicMessage[] | undefined
  messages.forEach((message, index) => {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) return
    if (stillOpen(messages, index)) return
    const { content, paired, dropped } = pairContent(message.content as AnthropicContentBlock[])
    if (paired.length === 0) return
    sanitized ??= [...messages]
    sanitized[index] = {
      ...message,
      content: content.length > 0 ? content : [{ type: 'text', text: EMPTIED_TURN }],
    }
    onPair?.({
      index,
      paired: paired.map((b) => ({
        type: b.type,
        id: b.id,
        name: b.name,
        server: b.server_name,
        ...(dropped.includes(b) ? { dropped: true as const } : {}),
      })),
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

/** Las tools que dejó afuera `dropUnknownToolReferences` en un mensaje del asistente. */
export interface DroppedToolReferences {
  /** Índice del mensaje del asistente en `messages`. */
  index: number
  tools: string[]
}

/**
 * Saca de los `tool_search_tool_result` de la conversación las `tool_reference` a tools que ya no
 * están en el `tools` del request: la API rechaza la conversación entera con un 400 "tool
 * reference not found". Pasa cuando la conversación sobrevive a las tools que la búsqueda
 * encontró —una retomada de un checkpoint cuando un MCP no respondió al arrancar (el agente corre
 * sin él) o cambió su catálogo—. Sólo se puede con el catálogo completo en la mano
 * (`mcpTransport: client`); con el conector las tools las lista Anthropic. Devuelve el mismo
 * array si no hubo nada que tocar.
 */
export function dropUnknownToolReferences(
  messages: AnthropicMessage[],
  known: ReadonlySet<string>,
  onDrop?: (dropped: DroppedToolReferences) => void,
): AnthropicMessage[] {
  let sanitized: AnthropicMessage[] | undefined
  messages.forEach((message, index) => {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) return
    const tools: string[] = []
    const content = (message.content as AnthropicContentBlock[]).map((block) => {
      const references = searchReferences(block)
      if (!references) return block
      const kept = references.filter((ref) => known.has(ref.tool_name))
      if (kept.length === references.length) return block
      tools.push(...references.filter((ref) => !kept.includes(ref)).map((ref) => ref.tool_name))
      const result = block.content as Record<string, unknown>
      return { ...block, content: { ...result, tool_references: kept } }
    })
    if (tools.length === 0) return
    sanitized ??= [...messages]
    sanitized[index] = { ...message, content }
    onDrop?.({ index, tools })
  })
  return sanitized ?? messages
}

/** Las `tool_reference` de un `tool_search_tool_result` exitoso; `undefined` en cualquier otro
 *  bloque (un result de error no trae referencias). */
function searchReferences(
  block: AnthropicContentBlock,
): Array<{ tool_name: string; [key: string]: unknown }> | undefined {
  if (block.type !== 'tool_search_tool_result') return undefined
  const result = block.content as { type?: unknown; tool_references?: unknown } | null
  if (result?.type !== 'tool_search_tool_search_result') return undefined
  return Array.isArray(result.tool_references) ? result.tool_references : undefined
}

/** Los nombres de las tools de un request (su `tools`), o `undefined` si no se conocen todos: un
 *  `mcp_toolset` del conector las trae del lado de Anthropic. */
export function knownToolNames(
  apiTools: ReadonlyArray<Record<string, unknown>>,
): ReadonlySet<string> | undefined {
  if (apiTools.some((tool) => tool.type === 'mcp_toolset')) return undefined
  return new Set(
    apiTools.map((tool) => tool.name).filter((name): name is string => typeof name === 'string'),
  )
}
