import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
// Structured logger — pretty console + JSON file
// Log file: $IA_FLOW_LOG_DIR/daemon.log (defaults to $IA_FLOW_CONFIG_DIR/logs,
// which itself defaults to ~/.config/ia-flow/logs). Kept out of the repo so
// running the server or the test suite doesn't pollute the working tree.
import pino from 'pino'

const HOME = Bun.env.HOME ?? ''
const DEFAULT_CONFIG_DIR = join(HOME, '.config', 'ia-flow')
const CONFIG_DIR = Bun.env.IA_FLOW_CONFIG_DIR ?? DEFAULT_CONFIG_DIR
const LOG_DIR = Bun.env.IA_FLOW_LOG_DIR ?? join(CONFIG_DIR, 'logs')
const LOG_FILE = join(LOG_DIR, 'daemon.log')
const LOG_LEVEL = (Bun.env.LOG_LEVEL ?? 'info') as pino.Level
// When set, every log line is also POSTed to another ia-flow server's
// `/api/remote-logs` (e.g. a headless engine forwarding into the main
// server's daemon.log/UI — see apps/server/docker/README.md). Fire-and-forget:
// a forwarding failure must never affect local logging.
const REMOTE_LOG_URL = Bun.env.IA_FLOW_REMOTE_LOG_URL
// Shared secret sent as `x-ia-flow-token` on outgoing forwards and checked by
// the receiving /api/remote-logs route — see routes/remote-logs.ts.
const REMOTE_LOG_TOKEN = Bun.env.IA_FLOW_REMOTE_LOG_TOKEN
const REMOTE_LOG_TIMEOUT_MS = 3_000

mkdirSync(LOG_DIR, { recursive: true })

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
  pino.transport({
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
      // File — newline-delimited JSON, easy to grep/tail
      {
        target: 'pino/file',
        level: LOG_LEVEL,
        options: {
          destination: LOG_FILE,
          append: true,
          mkdir: true,
          // Rotate at 50 MB (pino/file supports maxSize in newer versions)
        },
      },
    ],
  }),
)

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
        const { msg, extras } = normalize(a, b)
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
// Deliberately bypasses createLogger(): that factory's wrapped methods also
// forward to IA_FLOW_REMOTE_LOG_URL when set, and re-forwarding an ingested
// entry would turn any A→B (or accidental A→A) config into an infinite
// network/disk loop. Ingestion is a terminal sink by construction — there is
// no code path here that can call fetch(), regardless of this process's own
// REMOTE_LOG_URL setting.
export function ingestRemoteLogEntry(entry: {
  level: BroadcastLevel
  module: string
  msg: string
  extras?: Record<string, unknown>
}): void {
  const { level, module, msg, extras } = entry
  ingestChild(module)[level](extras ?? {}, msg)

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
