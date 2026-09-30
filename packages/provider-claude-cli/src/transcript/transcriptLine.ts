/**
 * Una línea de la transcripción JSONL que el CLI escribe en `~/.claude/projects/<cwd>/<sesión>.jsonl`
 * (el `transcript_path` de cada hook). Es la única fuente del uso de tokens y del modelo de una
 * sesión del CLI: el proceso no lo instrumentamos, pero cada mensaje del assistant trae el `usage`
 * del request que lo produjo. Portado de ia-flow v1 (`transcript-usage.ts`). Funciones puras.
 */

/** El uso de UN request al modelo, tal cual lo reporta la API. */
export interface TranscriptUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

/** Lo que aporta una línea: un pedazo de un mensaje del assistant (el CLI escribe una línea por
 *  bloque de contenido y todas repiten el `message.id`), u otra cosa (un turno del usuario, un
 *  resultado de tool) — que igual sirve: dice que el mensaje anterior ya terminó. */
export type TranscriptLine =
  | {
      kind: 'assistant'
      /** `message.id`; sin id, `undefined` (cuenta como un mensaje suelto). */
      id: string | undefined
      model?: string
      usage?: TranscriptUsage
      /** Los bloques `text` de esta línea. */
      texts: string[]
      /** ISO, cuando el CLI lo escribió. */
      timestamp?: string
      /** De un subagente (`Task`) escrito en la misma transcripción. */
      sidechain: boolean
    }
  | { kind: 'other' }

interface RawLine {
  type?: unknown
  timestamp?: unknown
  isSidechain?: unknown
  message?: {
    id?: unknown
    model?: unknown
    usage?: Record<string, unknown>
    content?: unknown
  }
}

const num = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0

/** El `usage` de la API a nuestra forma; `undefined` si no vino. */
export function usageOf(raw: unknown): TranscriptUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const usage = raw as Record<string, unknown>
  return {
    inputTokens: num(usage.input_tokens),
    outputTokens: num(usage.output_tokens),
    cacheReadTokens: num(usage.cache_read_input_tokens),
    cacheCreationTokens: num(usage.cache_creation_input_tokens),
  }
}

function textsOf(content: unknown): string[] {
  if (typeof content === 'string') return content ? [content] : []
  if (!Array.isArray(content)) return []
  return content.flatMap((block) => {
    const { type, text } = (block ?? {}) as { type?: unknown; text?: unknown }
    return type === 'text' && typeof text === 'string' && text ? [text] : []
  })
}

/** Una línea del JSONL → lo que aporta, o `undefined` si no es JSON (una línea rota o vacía no
 *  corta nada: se ignora). */
export function parseTranscriptLine(raw: string): TranscriptLine | undefined {
  const line = raw.trim()
  if (!line) return undefined
  let parsed: RawLine
  try {
    parsed = JSON.parse(line) as RawLine
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== 'object') return undefined
  if (parsed.type !== 'assistant') return { kind: 'other' }
  const message = parsed.message ?? {}
  const usage = usageOf(message.usage)
  return {
    kind: 'assistant',
    id: typeof message.id === 'string' && message.id ? message.id : undefined,
    ...(typeof message.model === 'string' ? { model: message.model } : {}),
    ...(usage ? { usage } : {}),
    texts: textsOf(message.content),
    ...(typeof parsed.timestamp === 'string' ? { timestamp: parsed.timestamp } : {}),
    sidechain: parsed.isSidechain === true,
  }
}
