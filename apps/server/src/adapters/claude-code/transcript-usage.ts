// Lee el usage de una sesión de Claude Code desde su transcripción JSONL.
//
// Un run de terminal corre en un proceso del CLI que este daemon no
// instrumenta, y `complete_task` lo llama el modelo, que no conoce su propia
// cuenta de tokens. Lo que sí queda es la transcripción que el CLI escribe en
// `~/.claude/projects/<cwd>/<session>.jsonl`: una línea por mensaje, y cada
// mensaje del assistant trae el `usage` del request que lo produjo. Sumarlos
// da el costo de la sesión con la misma forma que el loop de `anthropic-api`.
//
// El path llega por los hooks (`transcript_path`), así que esto es un adapter
// del daemon: sabe del formato de un producto concreto y toca el disco. El
// engine sólo ve la función inyectada (`setTranscriptUsageReader`).

import { readFileSync } from 'node:fs'
import type { TranscriptUsage } from '@ia-flow/agent-engine'

interface TranscriptUsageBlock {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

interface TranscriptLine {
  type?: string
  message?: {
    id?: string
    model?: string
    usage?: TranscriptUsageBlock
  }
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/**
 * Suma el usage de los mensajes del assistant. Pura: recibe el texto.
 *
 * Un mismo mensaje aparece en VARIAS líneas —el CLI escribe una por bloque
 * de contenido (texto, tool_use…) y todas repiten el `usage` del request
 * entero—, así que se deduplica por `message.id` quedándose con la última.
 * Sin eso un turno con tres tool_use contaría tres veces.
 *
 * El modelo es el que más mensajes produjo: una sesión puede mezclar (un
 * subagente en Haiku) y el costo exacto por modelo no está a este nivel —
 * el que domina es el que le pone precio al grueso de los tokens.
 */
type MessageUsage = { usage: TranscriptUsageBlock; model?: string }

/** Una línea del JSONL → su `(id, usage)`, o `undefined` si no aporta (no es
 *  JSON, no es del assistant, o no trae `usage`). */
function parseUsageLine(
  rawLine: string,
  anonymousId: string,
): { id: string; entry: MessageUsage } | undefined {
  const line = rawLine.trim()
  if (!line) return undefined
  let parsed: TranscriptLine
  try {
    parsed = JSON.parse(line) as TranscriptLine
  } catch {
    return undefined
  }
  if (parsed.type !== 'assistant') return undefined
  const usage = parsed.message?.usage
  if (!usage || typeof usage !== 'object') return undefined
  return { id: parsed.message?.id ?? anonymousId, entry: { usage, model: parsed.message?.model } }
}

/** Dedupe por `message.id` —el CLI repite el mismo `usage` en varias líneas
 *  del mismo mensaje—, quedándose con la última. */
function collectByMessage(text: string): Map<string, MessageUsage> {
  const byMessage = new Map<string, MessageUsage>()
  let anonymous = 0
  for (const rawLine of text.split('\n')) {
    const parsed = parseUsageLine(rawLine, `anon-${anonymous}`)
    if (!parsed) continue
    if (parsed.id.startsWith('anon-')) anonymous++
    byMessage.set(parsed.id, parsed.entry)
  }
  return byMessage
}

/** El modelo que más mensajes produjo: una sesión puede mezclar (un
 *  subagente en Haiku) y el que domina es el que le pone precio al grueso
 *  de los tokens. */
function dominantModel(entries: Iterable<MessageUsage>): string | undefined {
  const modelCount = new Map<string, number>()
  for (const { model } of entries) {
    if (model) modelCount.set(model, (modelCount.get(model) ?? 0) + 1)
  }
  let model: string | undefined
  let best = 0
  for (const [m, n] of modelCount) {
    if (n > best) {
      best = n
      model = m
    }
  }
  return model
}

export function parseTranscriptUsage(text: string): TranscriptUsage | undefined {
  const byMessage = collectByMessage(text)
  if (byMessage.size === 0) return undefined

  const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }
  for (const { usage } of byMessage.values()) {
    totals.inputTokens += num(usage.input_tokens)
    totals.outputTokens += num(usage.output_tokens)
    totals.cacheReadTokens += num(usage.cache_read_input_tokens)
    totals.cacheCreationTokens += num(usage.cache_creation_input_tokens)
  }
  const model = dominantModel(byMessage.values())
  return { usage: totals, ...(model ? { model } : {}) }
}

/** Lector que el composition root inyecta en el engine. Undefined si el
 *  archivo no existe o no se puede leer: el run cierra sin usage, como antes. */
export function readTranscriptUsage(path: string): TranscriptUsage | undefined {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  return parseTranscriptUsage(text)
}
