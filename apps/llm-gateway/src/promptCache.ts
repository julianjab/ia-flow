/** Anthropic admite como máximo 4 breakpoints de `cache_control` por request. */
const MAX_BREAKPOINTS = 4
const EPHEMERAL = { type: 'ephemeral' } as const

type Block = Record<string, unknown>
type Message = { content?: unknown }

const hasCache = (block: unknown): boolean =>
  typeof block === 'object' && block !== null && 'cache_control' in block

/** Anthropic rechaza `cache_control` en bloques vacíos. */
const cacheable = (block: Block): boolean =>
  !(block.type === 'text' && !block.text) &&
  !(block.type === 'tool_result' && (block.content == null || block.content === ''))

const asArray = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : [])

/** Un texto suelto (`system` o `content` como string) pasa a bloque de texto; un arreglo se copia. */
function asBlocks(value: unknown): Block[] {
  if (typeof value === 'string') return value ? [{ type: 'text', text: value }] : []
  return [...asArray<Block>(value)]
}

function countBreakpoints(body: Record<string, unknown>): number {
  const messageBlocks = asArray<Message>(body.messages).flatMap((m) => asArray(m.content))
  return [...asArray(body.tools), ...asArray(body.system), ...messageBlocks].filter(hasCache).length
}

/** Marca el último bloque si hay cupo; devuelve la lista (copiada) y si usó un breakpoint. */
function markLast(blocks: Block[], free: number): { blocks: Block[]; used: boolean } {
  const last = blocks[blocks.length - 1]
  if (!last || hasCache(last) || !cacheable(last) || free <= 0) return { blocks, used: false }
  return { blocks: [...blocks.slice(0, -1), { ...last, cache_control: EPHEMERAL }], used: true }
}

/** Marca con `cache_control: ephemeral` el prefijo estable del request: la última tool, el último
 *  bloque de `system` (que pasa a ser un arreglo de bloques) y el último bloque del último mensaje,
 *  para que cada vuelta reuse la conversación anterior. Respeta los breakpoints que el body ya trae
 *  (no los duplica) y el máximo de 4. Pura; sólo cambia el costo, no la respuesta. */
export function withPromptCache(body: Record<string, unknown>): Record<string, unknown> {
  let free = MAX_BREAKPOINTS - countBreakpoints(body)
  const out: Record<string, unknown> = { ...body }
  const apply = (blocks: Block[]): Block[] => {
    const marked = markLast(blocks, free)
    if (marked.used) free -= 1
    return marked.blocks
  }

  const tools = asBlocks(body.tools)
  if (tools.length > 0) out.tools = apply(tools)

  const system = asBlocks(body.system)
  if (system.length > 0) out.system = apply(system)

  const messages = asArray<Message>(body.messages)
  const lastMessage = messages[messages.length - 1]
  const content = lastMessage ? asBlocks(lastMessage.content) : []
  if (lastMessage && content.length > 0) {
    out.messages = [...messages.slice(0, -1), { ...lastMessage, content: apply(content) }]
  }
  return out
}
