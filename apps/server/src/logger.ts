import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Writable } from 'node:stream'
// Structured logger — pretty console + JSON file
// Log file: $IA_FLOW_LOG_DIR/daemon.<n>.log (defaults to $IA_FLOW_CONFIG_DIR/logs,
// which itself defaults to ~/.config/ia-flow/logs). Kept out of the repo so
// running the server or the test suite doesn't pollute the working tree.
import { DiagLogLevel, diag } from '@opentelemetry/api'
import { type AnyValueMap, SeverityNumber, logs } from '@opentelemetry/api-logs'
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs'
import pino from 'pino'
import { version as SERVICE_VERSION } from '../package.json'

const HOME = Bun.env.HOME ?? ''
const DEFAULT_CONFIG_DIR = join(HOME, '.config', 'ia-flow')
const CONFIG_DIR = Bun.env.IA_FLOW_CONFIG_DIR ?? DEFAULT_CONFIG_DIR
const LOG_DIR = Bun.env.IA_FLOW_LOG_DIR ?? join(CONFIG_DIR, 'logs')
// Base del nombre, sin extensión: pino-roll le agrega `.<n>.log`. Ver el
// target de abajo.
const LOG_FILE_BASE = join(LOG_DIR, 'daemon')
const LOG_LEVEL = (Bun.env.LOG_LEVEL ?? 'info') as pino.Level
// Rotación del archivo. Ver el target `pino-roll` más abajo para por qué es
// por tamaño y qué techo total implican estos dos juntos.
const LOG_MAX_SIZE = Bun.env.IA_FLOW_LOG_MAX_SIZE ?? '50m'
const LOG_MAX_FILES = Number(Bun.env.IA_FLOW_LOG_MAX_FILES ?? 4)
// When set, every log line is also POSTed to another ia-flow server's
// `/api/remote-logs` (e.g. a headless engine forwarding into the main
// server's daemon.log/UI — see agents/functional-refiner/README.md). Fire-and-forget:
// a forwarding failure must never affect local logging.
const REMOTE_LOG_URL = Bun.env.IA_FLOW_REMOTE_LOG_URL
// Shared secret sent as `x-ia-flow-token` on outgoing forwards and checked by
// the receiving /api/remote-logs route — see routes/remote-logs.ts. Trimmed
// to match remoteLogSecret() there: an untrimmed value (trailing newline
// from a `.env` file) would never equal the receiver's trimmed secret.
const REMOTE_LOG_TOKEN = Bun.env.IA_FLOW_REMOTE_LOG_TOKEN?.trim() || undefined
const REMOTE_LOG_TIMEOUT_MS = 3_000
// Tag identifying THIS process — set on headless engine containers
// (agents/subscriptions-pipeline, functional-refiner, implementer-accountant)
// so every log line and execution_logs row it produces can be told apart
// from the main daemon's own (unset = "main daemon"). Stamped into
// extras.source below on every line, whether it stays in this process's own
// daemon.log or gets forwarded via IA_FLOW_REMOTE_LOG_URL — see
// composition/container.ts for the execution_logs analog. Also feeds
// `service.instance.id` on the OTel sink (Q3 of docs/prd/otel-logs.md).
const INSTANCE_ID = Bun.env.IA_FLOW_INSTANCE_ID?.trim() || undefined

mkdirSync(LOG_DIR, { recursive: true })

// ── Sink OTel — quinto sink, opt-in por env ────────────────────────────────
//
// Bridge custom corriendo en el HILO PRINCIPAL, montado como un stream de
// `pino.multistream`. No es un `target` de `pino.transport` a propósito: los
// targets corren en el worker, y bajo Bun `pino-opentelemetry-transport`
// cuelga ese worker y se lleva puesto también al `pino/file` — o sea, mata al
// `daemon.log` que la UI lee. Ver Q1 de docs/prd/otel-logs.md.

const SEVERITY: Record<number, SeverityNumber> = {
  10: SeverityNumber.TRACE,
  20: SeverityNumber.DEBUG,
  30: SeverityNumber.INFO,
  40: SeverityNumber.WARN,
  50: SeverityNumber.ERROR,
  60: SeverityNumber.FATAL,
}

export interface OtelLogRecord {
  severityNumber: SeverityNumber
  body: string
  attributes: AnyValueMap
}

/**
 * Una línea NDJSON del stream raíz de pino → el record que el sink emite, o
 * `null` si esa línea no debe salir a OTel. Puro y exportado para poder
 * testear el filtro sin levantar un LoggerProvider.
 *
 * Descarta cuando `__iaFlowIngested === true`: es la marca que
 * `ingestRemoteLogEntry` estampa en lo que llega por `POST /api/remote-logs`.
 * Sin ese filtro, dos daemons encadenados y apuntados al mismo collector
 * duplicarían cada línea (el emisor la exporta, el receptor la re-exporta con
 * su propio `service.instance.id`) — el mismo loop A→B→A que el bypass de
 * `createLogger` ya evita para el forward HTTP. Loop prevention, Q5 del ADR.
 *
 * El archivo NDJSON y el broadcast WS **sí** siguen viendo la entrada: lo
 * único que se corta es la re-exportación.
 */
export function toOtelRecord(chunk: string): OtelLogRecord | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(chunk)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const {
    level,
    time: _time,
    msg,
    __iaFlowIngested,
    ...attributes
  } = parsed as Record<string, unknown>
  if (__iaFlowIngested === true) return null
  return {
    severityNumber: SEVERITY[Number(level)] ?? SeverityNumber.INFO,
    body: typeof msg === 'string' ? msg : '',
    attributes: attributes as AnyValueMap,
  }
}

/**
 * Los errores del exporter (collector caído, 5xx, timeout) llegan por el
 * `globalErrorHandler` de OTel, que los funnelea a `diag.error`. Los degradamos
 * a debug: sólo se ven con `LOG_LEVEL=debug` (u `OTEL_LOG_LEVEL=debug`), y van
 * a stderr crudo — deliberadamente **no** al logger de pino, porque un log del
 * fallo del sink volvería a entrar por ese mismo sink y realimentaría el error
 * cada `scheduledDelayMillis`.
 */
function installOtelDiag(): void {
  const verbose = (Bun.env.OTEL_LOG_LEVEL ?? LOG_LEVEL).trim().toLowerCase() === 'debug'
  const sink = (message: string, ...args: unknown[]): void => {
    if (!verbose) return
    process.stderr.write(`[otel] ${[message, ...args.map(String)].join(' ')}\n`)
  }
  diag.setLogger(
    { error: sink, warn: sink, info: sink, debug: sink, verbose: sink },
    DiagLogLevel.ALL,
  )
}

let otelProvider: LoggerProvider | null = null
// Se loguea una sola vez, después de construir el logger (acá todavía no
// existe). Fail-open: quedarse sin sink OTel es mejor que no arrancar.
let otelInitError: unknown = null

/**
 * `null` = sink apagado: sin `OTEL_EXPORTER_OTLP_ENDPOINT`, con
 * `OTEL_SDK_DISABLED=true`, o porque construir el provider falló (endpoint mal
 * formado, paquete que no resuelve). En los dos primeros casos ni siquiera se
 * construye el `LoggerProvider`. Fail-open — Q5 del ADR, mismo criterio que
 * `fileTarget()` del gateway: "el archivo es un extra, no un requisito".
 */
export function otelStream(): Writable | null {
  if (!Bun.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()) return null
  if (Bun.env.OTEL_SDK_DISABLED === 'true') return null
  try {
    installOtelDiag()
    const provider = new LoggerProvider({
      resource: resourceFromAttributes({
        'service.name': Bun.env.OTEL_SERVICE_NAME?.trim() || 'ia-flow-server',
        // Sin instancia, dos daemons son indistinguibles en el collector; el
        // pid al menos los separa dentro de un host.
        'service.instance.id': INSTANCE_ID ?? String(process.pid),
        'service.version': SERVICE_VERSION,
        'deployment.environment.name': Bun.env.OTEL_DEPLOYMENT_ENVIRONMENT?.trim() || 'development',
      }),
      // OJO: las opciones van como OBJETO. `new BatchLogRecordProcessor(exporter)`
      // compila y falla recién al emitir el primer record, en silencio.
      processors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })],
    })
    logs.setGlobalLoggerProvider(provider)
    otelProvider = provider
    const otel = logs.getLogger('ia-flow-server')
    return new Writable({
      write(chunk, _enc, cb) {
        try {
          const record = toOtelRecord(String(chunk))
          if (record) otel.emit(record)
        } catch {
          // Un record ilegible no puede frenar el stream: el cb() de abajo se
          // llama igual. Un cb() que no se llama congela el multistream entero,
          // o sea, el logging completo del proceso.
        }
        cb()
      },
    })
  } catch (err) {
    otelInitError = err
    return null
  }
}

// Cuánto se espera el flush del batch antes de seguir con el apagado igual.
const OTEL_FLUSH_TIMEOUT_MS = 1_000

/**
 * Vacía el batch en vuelo del `BatchLogRecordProcessor`. El grace de 200ms del
 * shutdown handler es para el worker de pino; el sink OTel corre en el hilo
 * principal y exporta en batches asíncronos, así que sin este flush la última
 * tanda se pierde en el `process.exit`. No-op cuando el sink está apagado.
 *
 * Acotado a `OTEL_FLUSH_TIMEOUT_MS`: con el collector inalcanzable,
 * `forceFlush()` arrastra el timeout de OTLP (10s) más su backoff, y el
 * shutdown handler quedaría esperándolo hasta comerse el grace del SIGTERM —
 * llevándose puesto el flush de pino a daemon.log, que es el sink que la UI
 * lee. El fail-open de Q5 también vale para el camino de apagado: si el batch
 * no salió a tiempo, se pierde ese batch, no el daemon.log.
 */
export function flushOtel(): Promise<void> {
  if (!otelProvider) return Promise.resolve()
  return Promise.race([
    otelProvider.forceFlush().catch(() => {}),
    new Promise<void>((resolve) => {
      setTimeout(resolve, OTEL_FLUSH_TIMEOUT_MS).unref?.()
    }),
  ])
}

let otelSink = otelStream()

// `pino.transport` levanta un worker thread y le pasa la config por
// structuredClone. Eso no sobrevive a un bundle: `bun build` deja el proceso
// sin los módulos que el worker resuelve por su cuenta y el arranque muere con
// `DataCloneError: The object can not be cloned` — antes de la primera línea
// de log, así que el fallo no deja rastro de sí mismo.
//
// En un contenedor ese transport no aporta nada de todos modos: los logs los
// junta el runtime desde stdout (`docker logs`), y el archivo va a un
// filesystem efímero que nadie lee. `LOG_PLAIN=true` (lo pone la imagen del
// runner) cambia a un stream directo a stdout, sin worker.
const plainStdout = Bun.env.LOG_PLAIN === 'true'

const consoleStream = plainStdout
  ? pino.destination({ dest: 1, sync: false })
  : pino.transport({
      targets: [
        // Console — pretty colored output
        {
          target: 'pino-pretty',
          level: LOG_LEVEL,
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss',
            ignore: 'pid,hostname',
            messageFormat: '[{module}] {msg}',
            singleLine: Bun.env.LOG_SINGLE_LINE === 'true',
          },
        },
        // File — newline-delimited JSON, easy to grep/tail.
        //
        // `pino-roll`, no `pino/file`: este target decía en un comentario que
        // rotaba a los 50 MB, pero `maxSize` nunca fue una opción de
        // `pino/file` y nunca se pasó — el daemon.log real llegó a 223 MB sin
        // que nada lo cortara. Por tamaño y NO por fecha a propósito: lo que
        // desborda acá es el volumen (un día de pipeline ocupado escribe más
        // que una semana tranquila), no el paso del tiempo.
        //
        // OJO — esto cambia el NOMBRE del archivo vivo: pino-roll escribe
        // `daemon.<n>.log` (n arranca en 1), no `daemon.log`. El lector de la
        // UI resuelve el más nuevo y cae al `daemon.log` legado si no hay
        // ninguno — ver resolveLogFile() en routes/server-logs.ts, que es el
        // único que tiene que saber esto. Al reiniciar, pino-roll retoma el
        // último `n` existente (detectLastNumber) en vez de empezar de cero.
        //
        // `limit.count` cuenta los archivos rotados SIN contar el activo, así
        // que el techo en disco es (count + 1) × size — con los defaults,
        // ~250 MB.
        {
          target: 'pino-roll',
          level: LOG_LEVEL,
          options: {
            file: LOG_FILE_BASE,
            extension: '.log',
            size: LOG_MAX_SIZE,
            limit: { count: LOG_MAX_FILES },
            mkdir: true,
          },
        },
      ],
    })

const streams = pino.multistream([
  { level: LOG_LEVEL, stream: consoleStream },
  ...(otelSink ? [{ level: LOG_LEVEL, stream: otelSink }] : []),
])

const logger = pino(
  {
    level: LOG_LEVEL,
    timestamp: pino.stdTimeFunctions.isoTime,
    base: { pid: process.pid },
    // Serializer: make Error objects readable
    serializers: {
      err: pino.stdSerializers.err,
      error: pino.stdSerializers.err,
    },
  },
  streams,
)

function warnIfOtelFailed(): void {
  if (!otelInitError) return
  logger.warn(
    { err: otelInitError },
    'OTel log sink disabled: failed to build the LoggerProvider — logging continues without it',
  )
  otelInitError = null
}
warnIfOtelFailed()

/**
 * Segundo intento de montar el sink, para el caso en que el endpoint no viene
 * del env del proceso sino de la UI.
 *
 * Este módulo se importa (y por lo tanto corre `otelStream()`) mucho antes de
 * que `envRepo.loadIntoProcess()` copie a `Bun.env` lo que el operador guardó
 * en SQLite — `index.ts` importa el logger en su línea 20 y llama a
 * `loadIntoProcess()` recién en la 149. Sin este segundo intento, las tres env
 * vars editables de Configuración serían letra muerta incluso reiniciando el
 * proceso, que es exactamente lo que su `description` promete que NO pasa.
 * Es el mismo desfase que `container.ts` ya documenta para el intervalo de
 * salud de los gateways remotos, resuelto de la misma forma: leer tarde.
 *
 * Idempotente: si el sink ya se armó con el env del deploy, no hace nada — así
 * las líneas del arranque (anteriores a `loadIntoProcess()`) también se
 * exportan cuando el endpoint viene por env.
 */
export function initOtelSink(): boolean {
  if (otelSink) return false
  otelSink = otelStream()
  if (!otelSink) {
    warnIfOtelFailed()
    return false
  }
  streams.add({ level: LOG_LEVEL, stream: otelSink })
  logger.info(
    { endpoint: Bun.env.OTEL_EXPORTER_OTLP_ENDPOINT },
    'OTel log sink enabled from the stored env vars',
  )
  return true
}

// Broadcast sink for live-log streaming. index.ts wires this to the WS
// broadcast function once the server is up; before wiring, calls are no-ops
// so logging during module init doesn't crash.
type BroadcastFn = (msg: object) => void
let broadcastFn: BroadcastFn | null = null
export function setLogBroadcast(fn: BroadcastFn): void {
  broadcastFn = fn
}

// Levels we mirror over the wire. `fatal` also flows so a crash isn't invisible
// on the UI side. `silent` and other pino internals are ignored.
const BROADCAST_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const
type BroadcastLevel = (typeof BROADCAST_LEVELS)[number]

// Only forward what the current LOG_LEVEL would have printed — spamming the WS
// with lower-level entries the file doesn't even keep would just waste bytes.
const LEVEL_ORDER: Record<string, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
}
const MIN_BROADCAST_LEVEL = LEVEL_ORDER[LOG_LEVEL] ?? 30

// Extract (msg, extras) from pino's positional args. Pino accepts:
//   log.info('msg')                 → arg1=string
//   log.info({ a: 1 }, 'msg')       → arg1=object, arg2=string
//   log.info({ a: 1 })              → arg1=object only
// We normalize into the shape the ServerLogEntry schema expects.
function normalize(arg1: unknown, arg2: unknown): { msg: string; extras: Record<string, unknown> } {
  if (typeof arg1 === 'string') {
    return { msg: arg1, extras: {} }
  }
  if (arg1 && typeof arg1 === 'object') {
    const rec = { ...(arg1 as Record<string, unknown>) }
    // Errors are serialized specially by pino; give the UI a plain string.
    if (rec.err instanceof Error) rec.err = { message: rec.err.message, stack: rec.err.stack }
    return { msg: typeof arg2 === 'string' ? arg2 : '', extras: rec }
  }
  return { msg: '', extras: {} }
}

// Child logger factory — adds `module` field to every log line and, when a
// broadcast fn is set, mirrors each entry to the WS clients as `log:entry`.
export function createLogger(module: string) {
  const child = logger.child({ module })

  for (const level of BROADCAST_LEVELS) {
    if ((LEVEL_ORDER[level] ?? 0) < MIN_BROADCAST_LEVEL) continue
    const original = child[level].bind(child) as (a?: unknown, b?: unknown) => void
    ;(child as unknown as Record<string, unknown>)[level] = (a?: unknown, b?: unknown): void => {
      original(a as never, b as never)
      const fn = broadcastFn
      if (!fn && !REMOTE_LOG_URL) return
      try {
        const { msg, extras: rawExtras } = normalize(a, b)
        // Stamp this process's identity so a viewer downstream (this
        // process's own WS clients, or the main daemon once forwarded) can
        // tell which container the line came from — see INSTANCE_ID above.
        const extras = INSTANCE_ID ? { ...rawExtras, source: INSTANCE_ID } : rawExtras
        if (fn) {
          fn({
            type: 'log:entry',
            entry: {
              time: new Date().toISOString(),
              level: level as BroadcastLevel,
              module,
              msg,
              extras,
            },
          })
        }
        if (REMOTE_LOG_URL) {
          fetch(REMOTE_LOG_URL, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...(REMOTE_LOG_TOKEN ? { 'x-ia-flow-token': REMOTE_LOG_TOKEN } : {}),
            },
            body: JSON.stringify({ level, module, msg, extras }),
            signal: AbortSignal.timeout(REMOTE_LOG_TIMEOUT_MS),
          }).catch(() => {})
        }
      } catch {
        // Never let a broadcast/remote-forward failure interfere with logging itself.
      }
    }
  }

  return child
}

// Bounded cache of raw `logger.child({module})` instances, used ONLY by
// ingestRemoteLogEntry below — never by createLogger's forwarding path. A
// forged/high-cardinality `module` from a hostile POST can't grow this
// unbounded: past the cap we evict the oldest entry (Map preserves insertion
// order) before inserting the new one.
const MAX_INGEST_CHILDREN = 500
const ingestChildren = new Map<string, pino.Logger>()

function ingestChild(module: string): pino.Logger {
  const existing = ingestChildren.get(module)
  if (existing) return existing
  if (ingestChildren.size >= MAX_INGEST_CHILDREN) {
    const oldest = ingestChildren.keys().next().value
    if (oldest !== undefined) ingestChildren.delete(oldest)
  }
  const child = logger.child({ module })
  ingestChildren.set(module, child)
  return child
}

// Entry point for POST /api/remote-logs (routes/remote-logs.ts) — writes a
// log line received from another ia-flow process into THIS process's own
// daemon.log + WS broadcast.
//
// Ingestion is a TERMINAL sink: an entry that came from another daemon never
// leaves this process again. Two mechanisms, one per outbound sink:
//
//  - HTTP forward: this function deliberately bypasses createLogger(), whose
//    wrapped methods POST to IA_FLOW_REMOTE_LOG_URL. Re-forwarding an ingested
//    entry would turn any A→B (or accidental A→A) config into an infinite
//    network/disk loop.
//  - OTel: the bypass above is NOT enough — the OTel sink hangs off pino's
//    ROOT stream (pino.multistream), so the raw logger.child() below flows
//    through it just fine. Hence the explicit `__iaFlowIngested: true` mark,
//    which toOtelRecord() filters on. Without it, two daemons chained and
//    pointed at the same collector duplicate every line: the emitter exports
//    it, and the receiver re-exports it under its own service.instance.id.
//
// ORDER MATTERS in the merge object below: the spread comes first and the mark
// last, because `extras` arrives raw from the POST body (routes/remote-logs.ts
// only bounds its size, not its keys). With the mark last, a hostile
// `extras: { __iaFlowIngested: false }` cannot switch it off. The key is
// namespaced so it can't collide with a legitimate extra from another daemon.
//
// The file and the WS broadcast still receive the entry — only the
// re-export is cut. See Q5 of docs/prd/otel-logs.md.
export function ingestRemoteLogEntry(entry: {
  level: BroadcastLevel
  module: string
  msg: string
  extras?: Record<string, unknown>
}): void {
  const { level, module, msg, extras } = entry
  ingestChild(module)[level]({ ...(extras ?? {}), __iaFlowIngested: true }, msg)

  const fn = broadcastFn
  if (!fn) return
  try {
    fn({
      type: 'log:entry',
      entry: { time: new Date().toISOString(), level, module, msg, extras: extras ?? {} },
    })
  } catch {
    // Never let a broadcast failure interfere with logging itself.
  }
}

export default logger
