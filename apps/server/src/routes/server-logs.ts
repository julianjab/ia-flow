import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  type ServerLogEntry,
  ServerLogFiltersSchema,
  ServerLogLevelSchema,
} from '@ia-flow/shared'
import { Hono } from 'hono'
import { createLogger } from '../logger.js'

const log = createLogger('server-logs')

const DEFAULT_LIMIT = 200
const MAX_LIMIT = 1000
// Above this size we tail the file (last N bytes) instead of reading it whole,
// to keep memory usage bounded on long-running daemons.
const LARGE_FILE_BYTES = 50 * 1024 * 1024 // 50 MB
const TAIL_BYTES = 5 * 1024 * 1024 // 5 MB — enough for tens of thousands of NDJSON lines

// Mirror of the resolution done in apps/server/src/logger.ts so both writer
// and reader agree on the path without leaking a module-level constant.
function resolveLogFile(): string {
  const HOME = Bun.env.HOME ?? ''
  const DEFAULT_CONFIG_DIR = join(HOME, '.config', 'ia-flow')
  const CONFIG_DIR = Bun.env.IA_FLOW_CONFIG_DIR ?? DEFAULT_CONFIG_DIR
  const LOG_DIR = Bun.env.IA_FLOW_LOG_DIR ?? join(CONFIG_DIR, 'logs')
  return join(LOG_DIR, 'daemon.log')
}

// Fixed keys that map to first-class fields on ServerLogEntry. Everything else
// on the raw NDJSON line (err, projectId, agentId, …) is stashed in `extras`.
const FIXED_KEYS = new Set(['level', 'time', 'pid', 'module', 'msg', 'hostname'])

// Pino writes `level` as a numeric code by default; keep this mapping local so
// the endpoint stays useful even when the log file was produced by a stricter
// pino config than the current logger.ts.
const LEVEL_NUMBER_TO_NAME: Record<number, string> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
}

function normalizeLevel(raw: unknown): string | null {
  if (typeof raw === 'string') return raw
  if (typeof raw === 'number') return LEVEL_NUMBER_TO_NAME[raw] ?? null
  return null
}

function parseLine(line: string): ServerLogEntry | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  let obj: Record<string, unknown>
  try {
    const parsed = JSON.parse(trimmed)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    obj = parsed as Record<string, unknown>
  } catch {
    return null
  }

  const levelName = normalizeLevel(obj.level)
  if (!levelName) return null
  const level = ServerLogLevelSchema.safeParse(levelName)
  if (!level.success) return null

  const time = typeof obj.time === 'string' ? obj.time : null
  if (!time) return null

  const msg = typeof obj.msg === 'string' ? obj.msg : ''

  const entry: ServerLogEntry = {
    level: level.data,
    time,
    msg,
  }
  if (typeof obj.pid === 'number') entry.pid = obj.pid
  if (typeof obj.module === 'string') entry.module = obj.module

  const extras: Record<string, unknown> = {}
  let hasExtras = false
  for (const [key, value] of Object.entries(obj)) {
    if (FIXED_KEYS.has(key)) continue
    extras[key] = value
    hasExtras = true
  }
  if (hasExtras) entry.extras = extras

  return entry
}

// Reads the daemon.log file, tailing the last TAIL_BYTES if it exceeds
// LARGE_FILE_BYTES. Returns raw text; caller splits into lines.
function readLogText(logFile: string): string {
  const stats = statSync(logFile)
  if (stats.size <= LARGE_FILE_BYTES) {
    return readFileSync(logFile, 'utf8')
  }
  // Tail: open, read the last TAIL_BYTES, drop the first (likely partial) line.
  const fd = Bun.file(logFile)
  // Bun.file supports slice() for byte ranges — cheaper than readFileSync on huge files.
  const start = stats.size - TAIL_BYTES
  const slice = fd.slice(start, stats.size)
  // Bun.file().slice() returns a Blob-like; read as text synchronously via
  // Bun's arrayBuffer helper. Route handler is async, so awaiting is fine.
  // We use a sync fallback here to keep parseAndFilter pure — see call site.
  // NOTE: caller awaits the returned promise.
  // Trick: assign then coerce.
  // biome-ignore lint/suspicious/noExplicitAny: Bun.file slice text() returns Promise<string>
  return (slice as any).textSync?.() ?? ''
}

// Async variant used by the handler — safer for large files (uses Bun streams).
async function readLogTextAsync(logFile: string): Promise<string> {
  const stats = statSync(logFile)
  if (stats.size <= LARGE_FILE_BYTES) {
    return readFileSync(logFile, 'utf8')
  }
  const start = stats.size - TAIL_BYTES
  const slice = Bun.file(logFile).slice(start, stats.size)
  const text = await slice.text()
  // Drop the (probably partial) first line so we don't emit a bogus entry.
  const nl = text.indexOf('\n')
  return nl === -1 ? '' : text.slice(nl + 1)
}

// Keep the sync helper referenced so bundlers don't tree-shake it away in
// case we want to fall back to it in tests. Prefer the async one at runtime.
void readLogText

export function createServerLogsRouter() {
  const app = new Hono()

  app.get('/', async (c) => {
    const q = c.req.query()
    const rawLimit = q.limit !== undefined ? Number(q.limit) : undefined
    const rawOffset = q.offset !== undefined ? Number(q.offset) : undefined
    const parsed = ServerLogFiltersSchema.safeParse({
      level: q.level,
      module: q.module,
      search: q.search,
      from: q.from,
      to: q.to,
      limit: rawLimit !== undefined && Number.isNaN(rawLimit) ? undefined : rawLimit,
      offset: rawOffset !== undefined && Number.isNaN(rawOffset) ? undefined : rawOffset,
    })
    if (!parsed.success) {
      return c.json({ error: 'Invalid query params', issues: parsed.error.issues }, 400)
    }

    const filters = parsed.data
    const limit = Math.min(Math.max(filters.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
    const offset = Math.max(filters.offset ?? 0, 0)

    const logFile = resolveLogFile()
    if (!existsSync(logFile)) {
      return c.json({ entries: [], total: 0 })
    }

    let text: string
    try {
      text = await readLogTextAsync(logFile)
    } catch (err) {
      log.error({ err, logFile }, 'failed to read daemon.log')
      return c.json({ entries: [], total: 0 })
    }

    const lines = text.split('\n')
    const entries: ServerLogEntry[] = []
    for (const line of lines) {
      const entry = parseLine(line)
      if (!entry) continue
      if (filters.level && entry.level !== filters.level) continue
      if (filters.module && entry.module !== filters.module) continue
      if (filters.search && !entry.msg.includes(filters.search)) continue
      if (filters.from && entry.time < filters.from) continue
      if (filters.to && entry.time > filters.to) continue
      entries.push(entry)
    }

    const total = entries.length
    const page = entries.slice(offset, offset + limit)
    return c.json({ entries: page, total })
  })

  return app
}
