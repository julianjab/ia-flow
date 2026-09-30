import { parseTranscriptLine, type TranscriptUsage } from './transcriptLine.js'

/** Un mensaje del assistant ya completo: un request al modelo, con su uso y su texto. */
export interface TranscriptMessage {
  id: string
  model?: string
  usage: TranscriptUsage
  /** El texto que escribió (sus bloques `text`, en orden). */
  texts: string[]
  timestamp?: string
  sidechain: boolean
}

interface Pending extends Omit<TranscriptMessage, 'usage'> {
  usage?: TranscriptUsage
}

/**
 * Arma los mensajes del assistant a medida que llegan las líneas, sin I/O: `push` devuelve los que
 * esa línea cerró. Un mensaje aparece en VARIAS líneas —una por bloque de contenido, todas con el
 * `usage` del request entero— así que se junta por `message.id` quedándose con el último `usage`
 * (sin eso, un turno con tres `tool_use` contaría tres veces). Un mensaje está completo cuando
 * llega una línea de otra cosa (el siguiente mensaje, un resultado de tool); el último de todos
 * queda abierto hasta `flush` (el `Stop` del CLI, o el fin de la corrida): todavía puede crecer.
 */
export class TranscriptAssembler {
  private pending: Pending | undefined
  private readonly emitted = new Set<string>()
  private anonymous = 0

  /** @param since los mensajes anteriores (una sesión retomada trae su historia) no se emiten. */
  constructor(private readonly since?: Date) {}

  push(raw: string): TranscriptMessage[] {
    const line = parseTranscriptLine(raw)
    if (!line) return []
    if (line.kind === 'assistant' && line.id !== undefined && line.id === this.pending?.id) {
      merge(this.pending, line)
      return []
    }
    const done = this.close()
    if (line.kind === 'assistant') {
      const id = line.id ?? `anon-${this.anonymous++}`
      // Ya salió (una línea suelta que vuelve a nombrarlo más tarde): no se cuenta dos veces.
      if (this.emitted.has(id)) return done
      this.pending = {
        id,
        ...(line.model ? { model: line.model } : {}),
        ...(line.usage ? { usage: line.usage } : {}),
        texts: [...line.texts],
        ...(line.timestamp ? { timestamp: line.timestamp } : {}),
        sidechain: line.sidechain,
      }
    }
    return done
  }

  /** Cierra el mensaje que quedó abierto: el modelo ya terminó. */
  flush(): TranscriptMessage[] {
    return this.close()
  }

  private close(): TranscriptMessage[] {
    const message = this.pending
    if (!message) return []
    this.pending = undefined
    this.emitted.add(message.id)
    if (!message.usage) return []
    if (this.since && message.timestamp && Date.parse(message.timestamp) < this.since.getTime()) {
      return []
    }
    return [{ ...message, usage: message.usage }]
  }
}

/** Otra línea del mismo mensaje: el `usage` y el modelo de la última, el texto que falte. */
function merge(
  pending: Pending,
  line: { usage?: TranscriptUsage; model?: string; texts: string[] },
): void {
  if (line.usage) pending.usage = line.usage
  if (line.model) pending.model = line.model
  for (const text of line.texts) if (!pending.texts.includes(text)) pending.texts.push(text)
}
