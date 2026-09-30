/**
 * `traceRecorder`: lo que ya emite la instrumentación (spans y logs), anotado como `TraceRecord`
 * en un `TraceJournal` — sólo lo que pertenece a una ejecución. Es cómo la app guarda en local (un
 * SQLite) la misma traza que manda por OTLP, para leerla sin un backend de trazas.
 *
 * ```ts
 * const recorder = traceRecorder(journal)
 * new NodeSDK({ spanProcessors: [otlpProcessor, recorder.spanProcessor] })
 * addLogSink(recorder.logSink)
 * ```
 *
 * Un span es de una ejecución si lleva `ia.execution.id` (el `pipeline <id>` lo hereda a todo lo de
 * adentro: agente, tools, provider), o si su padre —en la misma traza— es de una: así también entra
 * un span abierto sin los atributos heredados (una librería instrumentada por su cuenta).
 *
 * Sólo usa los TIPOS del SDK (`SpanProcessor`, `ReadableSpan`): la app registra el processor en
 * el SDK que eligió. Nunca tira: un journal que falla se ignora.
 */
import type { Attributes, AttributeValue, Context, HrTime } from '@opentelemetry/api'
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base'
import type { LogRecord, LogSink } from './logging.js'
import type { TraceJournal, TraceRecord, TraceValue } from './traceRecord.js'
import { truncate } from './tracing.js'

export interface TraceRecorderOptions {
  /** Quién emite: `runner` (default), o el id del host de un provider remoto. */
  origin?: string
  /** Tope de un string (un atributo, o cada item de una lista). Default 10 240. */
  maxStringLength?: number
  /** Cuántos spans recuerda para saber de qué ejecución es un hijo. Default 20 000. */
  maxTrackedSpans?: number
}

export interface TraceRecorder {
  /** Registralo en el `TracerProvider` del SDK, junto al exporter. */
  spanProcessor: SpanProcessor
  /** Sumalo a los destinos de los logs (`addLogSink`). */
  logSink: LogSink
}

export const EXECUTION_ATTRIBUTE = 'ia.execution.id'
const DEFAULT_MAX_STRING = 10_240
const DEFAULT_MAX_SPANS = 20_000
const STATUS = ['unset', 'ok', 'error'] as const

export function traceRecorder(
  journal: TraceJournal,
  options: TraceRecorderOptions = {},
): TraceRecorder {
  const origin = options.origin ?? 'runner'
  const maxString = options.maxStringLength ?? DEFAULT_MAX_STRING
  const spans = new SpanExecutions(options.maxTrackedSpans ?? DEFAULT_MAX_SPANS)

  const write = (record: TraceRecord) => {
    try {
      journal.write(record)
    } catch {
      // Un journal roto no puede tumbar lo que se está trazando.
    }
  }

  const recordSpan = (span: ReadableSpan, phase: 'start' | 'end') => {
    const { traceId, spanId } = span.spanContext()
    const parentSpanId = parentOf(span)
    const executionId =
      executionOf(span.attributes) ??
      spans.get(spanId) ??
      (parentSpanId ? spans.get(parentSpanId) : undefined)
    if (!executionId) return
    spans.set(spanId, executionId)
    write({
      kind: 'span',
      phase,
      name: span.name,
      startTime: iso(span.startTime),
      ...(phase === 'end' ? ending(span) : {}),
      traceId,
      spanId,
      ...(parentSpanId ? { parentSpanId } : {}),
      executionId,
      origin,
      attributes: sanitize(span.attributes, maxString),
    })
  }

  const spanProcessor: SpanProcessor = {
    onStart(span: Span, _parentContext: Context) {
      try {
        recordSpan(span, 'start')
      } catch {
        // Nunca tira: un span raro se pierde, no la corrida.
      }
    },
    onEnd(span: ReadableSpan) {
      try {
        recordSpan(span, 'end')
      } catch {
        // Idem.
      }
    },
    forceFlush: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
  }

  const logSink: LogSink = (record: LogRecord) => {
    try {
      const executionId =
        executionOf(record.attributes) ?? (record.spanId ? spans.get(record.spanId) : undefined)
      if (!executionId) return
      write({
        kind: 'log',
        name: truncate(record.message, maxString),
        scope: record.scope,
        level: record.level,
        startTime: record.time.toISOString(),
        traceId: record.traceId ?? '',
        spanId: record.spanId ?? '',
        executionId,
        origin,
        attributes: sanitize(record.attributes, maxString),
      })
    } catch {
      // Nunca tira.
    }
  }

  return { spanProcessor, logSink }
}

/**
 * spanId → ejecución, para los spans vistos hace poco: un hijo que no trae `ia.execution.id`
 * hereda la de su padre. Acotado (LRU): un span terminado sigue un rato por si todavía le nace un
 * hijo, y el más viejo se va primero.
 */
class SpanExecutions {
  private readonly map = new Map<string, string>()

  constructor(private readonly max: number) {}

  get(spanId: string): string | undefined {
    return this.map.get(spanId)
  }

  set(spanId: string, executionId: string): void {
    this.map.delete(spanId)
    this.map.set(spanId, executionId)
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      this.map.delete(oldest)
    }
  }
}

function executionOf(attributes: Attributes): string | undefined {
  const value = attributes[EXECUTION_ATTRIBUTE]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** El padre del span: `parentSpanContext` en el SDK 2.x, `parentSpanId` en el 1.x. */
function parentOf(span: ReadableSpan): string | undefined {
  const legacy = (span as { parentSpanId?: string }).parentSpanId
  return span.parentSpanContext?.spanId ?? legacy
}

/** Lo que un span sólo tiene al terminar: fin, duración y estado. */
function ending(span: ReadableSpan): Partial<TraceRecord> {
  const status = STATUS[span.status.code]
  return {
    endTime: iso(span.endTime),
    durationMs: millis(span.duration),
    ...(status ? { status } : {}),
    ...(span.status.message ? { statusMessage: span.status.message } : {}),
  }
}

function millis([seconds, nanos]: HrTime): number {
  return seconds * 1000 + nanos / 1e6
}

function iso(time: HrTime): string {
  return new Date(millis(time)).toISOString()
}

/** Los atributos como `TraceValue`: strings acotados, sin valores que no se pueden guardar. */
function sanitize(attributes: Attributes, maxString: number): Record<string, TraceValue> {
  const out: Record<string, TraceValue> = {}
  for (const [key, value] of Object.entries(attributes)) {
    const clean = sanitizeValue(value, maxString)
    if (clean !== undefined) out[key] = clean
  }
  return out
}

function sanitizeValue(
  value: AttributeValue | undefined,
  maxString: number,
): TraceValue | undefined {
  if (typeof value === 'string') return truncate(value, maxString)
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'boolean') return value
  if (!Array.isArray(value)) return undefined
  const items = (value as unknown[]).filter((item) => item !== null && item !== undefined)
  if (items.every((item) => typeof item === 'string')) {
    return items.map((item) => truncate(item, maxString))
  }
  if (items.every((item) => typeof item === 'number' && Number.isFinite(item))) {
    return items as number[]
  }
  if (items.every((item) => typeof item === 'boolean')) return items as boolean[]
  // Una lista mezclada no es un atributo válido de OTel: se guarda como strings.
  return items.map((item) => truncate(String(item), maxString))
}
