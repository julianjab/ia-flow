import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { type ServerLogEntry, ServerLogFiltersSchema, ServerLogLevelSchema } from '@ia-flow/shared'
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

// Reads the daemon.log, tailing the last TAIL_BYTES if it exceeds
// LARGE_FILE_BYTES. Drops the (likely partial) first line when tailing so we
// don't emit a corrupt entry.
async function readLogText(logFile: string): Promise<string> {
  const stats = statSync(logFile)
  if (stats.size <= LARGE_FILE_BYTES) {
    return readFileSync(logFile, 'utf8')
  }
  const start = stats.size - TAIL_BYTES
  const slice = Bun.file(logFile).slice(start, stats.size)
  const text = await slice.text()
  const nl = text.indexOf('\n')
  return nl === -1 ? '' : text.slice(nl + 1)
}

// Cheap read of the full log to collect distinct module names. Used by the
// UI to show every module ever emitted as a multi-select chip, not just the
// ones on the current page. Bounded by the same tail behavior as the main
// query so an ever-growing log stays cheap.
async function readAllModules(): Promise<string[]> {
  const logFile = resolveLogFile()
  if (!existsSync(logFile)) return []
  let text: string
  try {
    text = await readLogText(logFile)
  } catch {
    return []
  }
  const modules = new Set<string>()
  for (const line of text.split('\n')) {
    const entry = parseLine(line)
    if (entry?.module) modules.add(entry.module)
  }
  return Array.from(modules).sort((a, b) => a.localeCompare(b))
}

export function createServerLogsRouter() {
  const app = new Hono()

  app.get('/modules', async (c) => {
    const modules = await readAllModules()
    return c.json({ modules })
  })

  app.get('/', async (c) => {
    const q = c.req.query()
    const rawLimit = q.limit !== undefined ? Number(q.limit) : undefined
    const rawOffset = q.offset !== undefined ? Number(q.offset) : undefined
    // Hono returns undefined when the key is absent; queries() returns []
    // when the key appears zero times. Prefer the array form so callers can
    // pass ?module=a&module=b for multi-select filtering.
    const moduleValues = c.req.queries('module') ?? []
    const rawModule = moduleValues.length > 1 ? moduleValues : (moduleValues[0] ?? q.module)
    const parsed = ServerLogFiltersSchema.safeParse({
      level: q.level,
      module: rawModule,
      search: q.search,
      from: q.from,
      to: q.to,
      limit: rawLimit !== undefined && Number.isNaN(rawLimit) ? undefined : rawLimit,
      offset: rawOffset !== undefined && Number.isNaN(rawOffset) ? undefined : rawOffset,
      sort: q.sort,
      sortBy: q.sortBy,
    })
    if (!parsed.success) {
      return c.json({ error: 'Invalid query params', issues: parsed.error.issues }, 400)
    }

    const filters = parsed.data
    const limit = Math.min(Math.max(filters.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
    const offset = Math.max(filters.offset ?? 0, 0)
    const sort = filters.sort ?? 'desc'
    const sortBy = filters.sortBy ?? 'time'
    // Normalize module filter to a Set for O(1) membership checks. Empty
    // strings from ?module= (no value) are dropped so they don't filter
    // everything out.
    const moduleSet = (() => {
      const raw = filters.module
      if (!raw) return null
      const arr = Array.isArray(raw) ? raw : [raw]
      const cleaned = arr.map((m) => m.trim()).filter((m) => m.length > 0)
      return cleaned.length > 0 ? new Set(cleaned) : null
    })()

    const logFile = resolveLogFile()
    if (!existsSync(logFile)) {
      return c.json({
        entries: [],
        total: 0,
        levelCounts: { trace: 0, debug: 0, info: 0, warn: 0, error: 0, fatal: 0 },
      })
    }

    let text: string
    try {
      text = await readLogText(logFile)
    } catch (err) {
      log.error({ err, logFile }, 'failed to read daemon.log')
      return c.json({
        entries: [],
        total: 0,
        levelCounts: { trace: 0, debug: 0, info: 0, warn: 0, error: 0, fatal: 0 },
      })
    }

    const lines = text.split('\n')
    const entries: ServerLogEntry[] = []
    // Level breakdown across everything that matches the NON-level filters.
    // Sending this back lets the UI's summary chips show the full universe
    // regardless of the current level filter or pagination.
    const levelCounts: Record<string, number> = {
      trace: 0,
      debug: 0,
      info: 0,
      warn: 0,
      error: 0,
      fatal: 0,
    }
    for (const line of lines) {
      const entry = parseLine(line)
      if (!entry) continue
      if (moduleSet && (!entry.module || !moduleSet.has(entry.module))) continue
      if (filters.search && !entry.msg.includes(filters.search)) continue
      if (filters.from && entry.time < filters.from) continue
      if (filters.to && entry.time > filters.to) continue
      levelCounts[entry.level]++
      if (filters.level && entry.level !== filters.level) continue
      entries.push(entry)
    }

    // Sort the FULL filtered set before paginating so page 2 keeps the
    // same ordering as page 1 (`entries` is already time-ascending — the
    // natural read order of the NDJSON file).
    const LEVEL_RANK: Record<string, number> = {
      trace: 0,
      debug: 1,
      info: 2,
      warn: 3,
      error: 4,
      fatal: 5,
    }
    const dir = sort === 'asc' ? 1 : -1
    if (sortBy === 'time') {
      if (sort === 'desc') entries.reverse()
    } else {
      entries.sort((a, b) => {
        let cmp = 0
        if (sortBy === 'level') cmp = (LEVEL_RANK[a.level] ?? 0) - (LEVEL_RANK[b.level] ?? 0)
        else if (sortBy === 'module') cmp = (a.module ?? '').localeCompare(b.module ?? '')
        else if (sortBy === 'msg') cmp = a.msg.localeCompare(b.msg)
        // Stable tie-breaker: fall back to time so equal-key rows still
        // land in a deterministic order across pages.
        if (cmp === 0) cmp = a.time.localeCompare(b.time)
        return cmp * dir
      })
    }

    const total = entries.length
    const page = entries.slice(offset, offset + limit)
    return c.json({ entries: page, total, levelCounts })
  })

  return app
}
