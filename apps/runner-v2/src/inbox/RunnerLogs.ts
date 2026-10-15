/**
 * El log del proceso del runner para quien lo mira por HTTP (`GET /api/logs`: el menubar, la web):
 * las últimas líneas de `createLogger`, en memoria y con los secretos tapados. No reemplaza a OTLP
 * ni al stdout: es la cola corta para ver qué está haciendo el server sin entrar al pod.
 */

import type { RunnerLogLine, RunnerLogs as RunnerLogsPage } from '@ia-flow/shared'
import { type LogLevel, type LogRecord, redactSecrets } from '@ia-flow/telemetry'

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

/** Cuántas líneas se guardan si no se dice otra cosa. */
export const DEFAULT_LOG_CAPACITY = 2000

/** El tope de un pedido: más que eso, se pide de nuevo con `after`. */
const MAX_PAGE = 1000

/** Un atributo largo (un prompt, un payload) se corta: es una vista de log, no la traza. */
const MAX_FIELDS_LENGTH = 600

function fieldsOf(attributes: LogRecord['attributes']): string | undefined {
  const entries = Object.entries(redactSecrets(attributes))
  if (entries.length === 0) return undefined
  const text = entries
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' ')
  return text.length > MAX_FIELDS_LENGTH ? `${text.slice(0, MAX_FIELDS_LENGTH)}…` : text
}

export interface LogQuery {
  /** Sólo las líneas con `seq` mayor. */
  after?: number
  /** Las últimas N que cumplen el filtro. */
  limit?: number
  /** El nivel mínimo. */
  level?: LogLevel
  /** Texto que tiene que aparecer en el mensaje, el scope o los atributos (sin mayúsculas). */
  text?: string
}

export class RunnerLogs {
  private readonly lines: RunnerLogLine[] = []
  private seq = 0

  constructor(readonly capacity = DEFAULT_LOG_CAPACITY) {}

  /** El sink para `addLogSink`: anota cada log del proceso. */
  readonly sink = (record: LogRecord): void => {
    this.seq += 1
    const fields = fieldsOf(record.attributes)
    this.lines.push({
      seq: this.seq,
      time: record.time.toISOString(),
      level: record.level,
      scope: record.scope,
      message: redactSecrets(record.message),
      ...(fields ? { fields } : {}),
      ...(record.traceId ? { trace_id: record.traceId } : {}),
    })
    if (this.lines.length > this.capacity) this.lines.splice(0, this.lines.length - this.capacity)
  }

  page(query: LogQuery = {}): RunnerLogsPage {
    const min = LEVEL_ORDER[query.level ?? 'debug']
    const text = query.text?.trim().toLowerCase()
    const matching = this.lines.filter(
      (line) =>
        line.seq > (query.after ?? 0) &&
        LEVEL_ORDER[line.level] >= min &&
        (!text ||
          `${line.scope} ${line.message} ${line.fields ?? ''}`.toLowerCase().includes(text)),
    )
    const limit = Math.min(Math.max(query.limit ?? 200, 1), MAX_PAGE)
    return { lines: matching.slice(-limit), last_seq: this.seq, capacity: this.capacity }
  }
}
