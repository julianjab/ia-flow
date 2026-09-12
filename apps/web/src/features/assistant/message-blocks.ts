// El asistente conversacional (ver el prompt en `base-agents.yaml`) responde
// en un subset de Markdown deliberadamente chico — lo mínimo para que una
// lista de tareas no se vea como un bloque de texto sin jerarquía, sin
// arrastrar un parser de Markdown completo (ni `v-html`: todo lo que sigue
// se arma con nodos de Vue, nunca HTML crudo del modelo):
//
//   - `**negrita**` y `` `código` `` inline.
//   - Una línea con sólo `---` es un separador visual entre ítems.
//   - Un link inline dentro de una oración: `[texto](/path)`.
//   - Una referencia destacada (una tarea puntual, un proyecto): un fence de
//     código ```iaflow:task``` / ```iaflow:project``` con un objeto JSON — es
//     "structured output" real (el modelo arma el JSON, no prosa que hay que
//     adivinar) en vez de una cuarta convención de texto libre. Se renderiza
//     como una tarjeta clickeable en vez de una línea de texto más.
//
// El `path` SIEMPRE es relativo — el asistente no conoce el origin del
// browser que lo está usando — y siempre viene de un campo `path` que ya
// trajo una tool (`packages/tools/src/task/task-query.ts`); el modelo nunca
// lo inventa. Un fence con JSON inválido o sin los campos mínimos se muestra
// como texto crudo en vez de romper el render.
export type MessageBlock =
  | { type: 'text'; text: string }
  | { type: 'bold'; text: string }
  | { type: 'code'; text: string }
  | { type: 'link'; text: string; path: string }
  | { type: 'divider' }
  | { type: 'task-card'; title: string; path: string; status?: string }
  | { type: 'project-card'; name: string; path: string }

const INLINE_PATTERN = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((\/[^\s)]+)\)/g
const CARD_PATTERN = /```iaflow:(task|project)\s*\n([\s\S]*?)```/g
const DIVIDER_LINE = /^\s*---\s*$/
/** Todo comentario que postea un agente del engine arranca con este header
 *  (`Agent.ts`, `# ${agentDef.id}\n\n...`) — es lo que `selectCommentWindow`
 *  usa para reconocer "mi propio último comentario", no algo que el
 *  operador necesita ver: el widget ya distingue autor por el lado de la
 *  burbuja. */
const AGENT_HEADER = /^#\s+\S+\n\n/

export function parseMessageBlocks(rawBody: string): MessageBlock[] {
  const body = rawBody.replace(AGENT_HEADER, '')
  const blocks: MessageBlock[] = []
  let lastIndex = 0
  for (const match of body.matchAll(CARD_PATTERN)) {
    const [full, kind, jsonText] = match
    const index = match.index ?? 0
    if (index > lastIndex) blocks.push(...parseTextChunk(body.slice(lastIndex, index)))
    blocks.push(parseCard(kind as 'task' | 'project', jsonText) ?? { type: 'text', text: full })
    lastIndex = index + full.length
  }
  if (lastIndex < body.length) blocks.push(...parseTextChunk(body.slice(lastIndex)))
  return blocks
}

function parseCard(kind: 'task' | 'project', jsonText: string): MessageBlock | null {
  let data: unknown
  try {
    data = JSON.parse(jsonText.trim())
  } catch {
    return null
  }
  if (typeof data !== 'object' || data === null) return null
  const { path } = data as { path?: unknown }
  if (typeof path !== 'string' || !path.startsWith('/')) return null
  if (kind === 'task') {
    const { title, status } = data as { title?: unknown; status?: unknown }
    if (typeof title !== 'string') return null
    return {
      type: 'task-card',
      title,
      path,
      status: typeof status === 'string' ? status : undefined,
    }
  }
  const { name } = data as { name?: unknown }
  if (typeof name !== 'string') return null
  return { type: 'project-card', name, path }
}

/** Parte un chunk de texto (sin fences de card adentro) en líneas, sacando
 *  los separadores `---` como su propio bloque, y corre el inline parser
 *  sobre el resto — así un `---` no queda atrapado en el medio de un bloque
 *  `text` de varias líneas. */
function parseTextChunk(text: string): MessageBlock[] {
  const blocks: MessageBlock[] = []
  const lines = text.split('\n')
  let buffer: string[] = []
  const flush = () => {
    if (!buffer.length) return
    blocks.push(...parseInline(buffer.join('\n')))
    buffer = []
  }
  for (const line of lines) {
    if (DIVIDER_LINE.test(line)) {
      flush()
      blocks.push({ type: 'divider' })
    } else {
      buffer.push(line)
    }
  }
  flush()
  return blocks
}

function parseInline(text: string): MessageBlock[] {
  const blocks: MessageBlock[] = []
  let lastIndex = 0
  for (const match of text.matchAll(INLINE_PATTERN)) {
    const [full, bold, code, linkText, linkPath] = match
    const index = match.index ?? 0
    if (index > lastIndex) blocks.push({ type: 'text', text: text.slice(lastIndex, index) })
    if (bold !== undefined) blocks.push({ type: 'bold', text: bold })
    else if (code !== undefined) blocks.push({ type: 'code', text: code })
    else blocks.push({ type: 'link', text: linkText, path: linkPath })
    lastIndex = index + full.length
  }
  if (lastIndex < text.length) blocks.push({ type: 'text', text: text.slice(lastIndex) })
  return blocks
}
