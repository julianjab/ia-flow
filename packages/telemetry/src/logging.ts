/**
 * Logging compuesto, portado de la idea de ia-flow (`createLogger('scope')` + sinks) sin su
 * `setLoggerFactory`: acá el logger no se inyecta ni se rebindea — cada log se reparte, al
 * emitirse, entre los sinks configurados en ese momento. Una clase declara su logger como campo
 * (`readonly log = createLogger('engine')`) y no sabe a dónde va lo que loguea; con ese campo,
 * `@traced` además loguea solo los errores que se escapan del método.
 *
 * La app decide los destinos una vez al bootear:
 *
 * ```ts
 * setLogSinks([consoleSink({ level: 'debug' }), otelSink(), (record) => miArchivo.write(record)]);
 * ```
 *
 * Por defecto sólo `otelSink()`: sin un SDK de OTel registrado es un no-op, así que una librería
 * que usa este paquete no escribe nada por su cuenta. Un sink con I/O propio (archivo rotativo,
 * pino, un POST) lo arma la app — este paquete no toca red ni filesystem.
 *
 * Un log sale con el `traceId`/`spanId` y los atributos heredados del contexto ACTIVO al emitir,
 * no de dónde se creó el logger: un logger por clase, en cualquier paquete, igual arma una sola
 * traza con todos los logs.
 */
import { context, trace } from '@opentelemetry/api'
import { logs, SeverityNumber } from '@opentelemetry/api-logs'
import { type Attributes, INSTRUMENTATION_SCOPE, inheritedAttributes } from './tracing.js'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

/** Lo que recibe cada sink: ya trae los atributos heredados (`ia.issue`, `ia.pipeline.id`, …) y
 *  los ids de la traza activa, para correlacionar un log de consola con su span. */
export interface LogRecord {
  time: Date
  level: LogLevel
  /** El `scope` de `createLogger` — qué módulo logueó. */
  scope: string
  message: string
  attributes: Attributes
  traceId?: string
  spanId?: string
}

/** Un destino de logs. No debería tirar; si tira, se ignora y el resto de los sinks sigue. */
export type LogSink = (record: LogRecord) => void

export interface Logger {
  debug(message: string, attributes?: Attributes): void
  info(message: string, attributes?: Attributes): void
  warn(message: string, attributes?: Attributes): void
  error(message: string, attributes?: Attributes): void
}

const SEVERITY: Record<LogLevel, SeverityNumber> = {
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
}

/** Al Logs API de OTel: el SDK de la app lo exporta (OTLP → Loki/Datadog) y le pone
 *  trace_id/span_id. Sin SDK, no-op. El `scope` del log es su instrumentation scope. */
export function otelSink(): LogSink {
  return (record) => {
    logs.getLogger(record.scope).emit({
      timestamp: record.time,
      severityNumber: SEVERITY[record.level],
      severityText: record.level.toUpperCase(),
      body: record.message,
      attributes: record.attributes,
      context: context.active(),
    })
  }
}

export interface ConsoleSinkOptions {
  /** Nivel mínimo. Default `info`. */
  level?: LogLevel
  /** `pretty` (default): una línea legible. `json`: una línea JSON por log, para un colector. */
  format?: 'pretty' | 'json'
}

/** A la consola (`console.log`/`warn`/`error` según el nivel). */
export function consoleSink(options: ConsoleSinkOptions = {}): LogSink {
  const min = LEVEL_ORDER[options.level ?? 'info']
  const format = options.format ?? 'pretty'
  return (record) => {
    if (LEVEL_ORDER[record.level] < min) return
    const write =
      record.level === 'error'
        ? console.error
        : record.level === 'warn'
          ? console.warn
          : console.log
    write(format === 'json' ? JSON.stringify(record) : pretty(record))
  }
}

function pretty({ time, level, scope, message, attributes }: LogRecord): string {
  const fields = Object.entries(attributes)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' ')
  const head = `${time.toISOString().slice(11, 23)} ${level.toUpperCase().padEnd(5)} [${scope}]`
  return fields ? `${head} ${message} ${fields}` : `${head} ${message}`
}

let sinks: LogSink[] = [otelSink()]

let minLevel: LogLevel = 'info'

/** Nivel mínimo de TODOS los loggers y sinks (default `info`): lo de abajo no se emite. La app lo
 *  fija una vez al bootear (el runner, desde `LOG_LEVEL`). */
export function setLogLevel(level: LogLevel): void {
  minLevel = level
}

/** Si un log de este nivel se emitiría — para no armar un payload caro (un body entero de debug)
 *  que después se descarta. */
export function isLogLevelEnabled(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[minLevel]
}

/** `LOG_LEVEL` (o cualquier texto) → un `LogLevel`, o `undefined` si no es uno. */
export function parseLogLevel(value: string | undefined): LogLevel | undefined {
  const level = value?.trim().toLowerCase()
  return level && Object.hasOwn(LEVEL_ORDER, level) ? (level as LogLevel) : undefined
}

/** Reemplaza los destinos de TODOS los loggers, incluidos los ya creados. */
export function setLogSinks(next: LogSink[]): void {
  sinks = [...next]
}

/** Suma un destino a los actuales. Devuelve con qué sacarlo. */
export function addLogSink(sink: LogSink): () => void {
  sinks = [...sinks, sink]
  return () => {
    sinks = sinks.filter((current) => current !== sink)
  }
}

function emit(level: LogLevel, scope: string, message: string, attributes: Attributes): void {
  if (!isLogLevelEnabled(level)) return
  const span = trace.getActiveSpan()?.spanContext()
  const record: LogRecord = {
    time: new Date(),
    level,
    scope,
    message,
    attributes: { ...inheritedAttributes(), ...attributes },
    ...(span ? { traceId: span.traceId, spanId: span.spanId } : {}),
  }
  for (const sink of sinks) {
    try {
      sink(record)
    } catch {
      // Un sink roto no puede tumbar lo que se está logueando ni a los demás sinks.
    }
  }
}

/** Un logger con nombre. Crealo a nivel de módulo: los destinos se resuelven al emitir. */
export function createLogger(scope: string = INSTRUMENTATION_SCOPE): Logger {
  return {
    debug: (message, attributes = {}) => emit('debug', scope, message, attributes),
    info: (message, attributes = {}) => emit('info', scope, message, attributes),
    warn: (message, attributes = {}) => emit('warn', scope, message, attributes),
    error: (message, attributes = {}) => emit('error', scope, message, attributes),
  }
}
