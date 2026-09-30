/**
 * Lo que queda de una ejecución además de su traza en OTLP: cada span (al empezar y al terminar) y
 * cada log que lleve `ia.execution.id`, como datos planos. Es un tipo neutro — sin tipos del SDK de
 * OpenTelemetry — para que quien lo guarda (un SQLite, el sync de un provider remoto) no dependa
 * del SDK. Lo arma `traceRecorder` a partir de los spans y logs que ya emite la instrumentación.
 */

/** Un valor de atributo tal cual lo acepta OpenTelemetry. */
export type TraceValue = string | number | boolean | string[] | number[] | boolean[]

export interface TraceRecord {
  kind: 'span' | 'log'
  /** Sólo spans: `start` cuando arranca (una tool en curso se ve), `end` cuando termina. */
  phase?: 'start' | 'end'
  /** El nombre del span, o el mensaje del log. */
  name: string
  /** El scope del logger (`createLogger('scope')`), en los logs. */
  scope?: string
  level?: 'debug' | 'info' | 'warn' | 'error'
  /** Sólo spans al terminar. */
  status?: 'ok' | 'error' | 'unset'
  statusMessage?: string
  /** ISO. */
  startTime: string
  endTime?: string
  durationMs?: number
  traceId: string
  spanId: string
  parentSpanId?: string
  /** La ejecución a la que pertenece: lo que no la tiene no se registra. */
  executionId: string
  /** Quién lo emitió: `runner`, o el id del host de un provider remoto. */
  origin: string
  attributes: Record<string, TraceValue>
}

/** Dónde se anota cada `TraceRecord`, en el momento (sin lotes). No debería tirar. */
export interface TraceJournal {
  write(record: TraceRecord): void
}
