import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
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
function resolveLogDir(): string {
  const HOME = Bun.env.HOME ?? ''
  const DEFAULT_CONFIG_DIR = join(HOME, '.config', 'ia-flow')
  const CONFIG_DIR = Bun.env.IA_FLOW_CONFIG_DIR ?? DEFAULT_CONFIG_DIR
  return Bun.env.IA_FLOW_LOG_DIR ?? join(CONFIG_DIR, 'logs')
}

// `daemon.12.log` → 12. Null para cualquier otro nombre del directorio.
function rollNumber(name: string): number | null {
  const m = name.match(/^daemon\.(\d+)\.log$/)
  return m ? Number(m[1]) : null
}

/**
 * El archivo que el daemon está escribiendo AHORA.
 *
 * Desde que el sink rota (pino-roll, ver logger.ts) el nombre lleva un
 * contador: `daemon.1.log`, `daemon.2.log`, … El activo es el de número más
 * alto, no el de mtime más reciente — un `touch` o un rsync sobre uno viejo
 * no debería redirigir la lectura.
 *
 * Cae a `daemon.log` cuando no hay ninguno: es el archivo que dejó cualquier
 * instalación anterior a la rotación, y hasta el primer arranque con el sink
 * nuevo es el único que tiene historia.
 */
function resolveLogFile(): string {
  const dir = resolveLogDir()
  let best: { n: number; name: string } | null = null
  try {
    for (const name of readdirSync(dir)) {
      const n = rollNumber(name)
      if (n == null || (best && n <= best.n)) continue
      best = { n, name }
    }
  } catch {
    // Directorio inexistente (primer arranque): el fallback de abajo tampoco
    // va a existir, y todos los llamadores ya chequean con existsSync.
  }
  return join(dir, best?.name ?? 'daemon.log')
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

// Same idea as readAllModules, for extras.source — the IA_FLOW_INSTANCE_ID
// tag every log line from a headless container carries (locally and when
// forwarded, see logger.ts). Absent means the main daemon itself.
async function readAllSources(): Promise<string[]> {
  const logFile = resolveLogFile()
  if (!existsSync(logFile)) return []
  let text: string
  try {
    text = await readLogText(logFile)
  } catch {
    return []
  }
  const sources = new Set<string>()
  for (const line of text.split('\n')) {
    const entry = parseLine(line)
    const source = entry?.extras?.source
    if (typeof source === 'string' && source) sources.add(source)
  }
  return Array.from(sources).sort((a, b) => a.localeCompare(b))
}

export function createServerLogsRouter() {
  const app = new Hono()

  app.get('/modules', async (c) => {
    const modules = await readAllModules()
    return c.json({ modules })
  })

  app.get('/sources', async (c) => {
    const sources = await readAllSources()
    return c.json({ sources })
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
    const sourceValues = c.req.queries('source') ?? []
    const rawSource = sourceValues.length > 1 ? sourceValues : (sourceValues[0] ?? q.source)
    const parsed = ServerLogFiltersSchema.safeParse({
      level: q.level,
      module: rawModule,
      source: rawSource,
      search: q.search,
      from: q.from,
      to: q.to,
      limit: rawLimit !== undefined && Number.isNaN(rawLimit) ? undefined : rawLimit,
      offset: rawOffset !== undefined && Number.isNaN(rawOffset) ? undefined : rawOffset,
      sort: q.sort,
      sortBy: q.sortBy,
      runId: q.runId,
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
    const sourceSet = (() => {
      const raw = filters.source
      if (!raw) return null
      const arr = Array.isArray(raw) ? raw : [raw]
      const cleaned = arr.map((s) => s.trim()).filter((s) => s.length > 0)
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
      if (sourceSet) {
        const source = entry.extras?.source
        if (typeof source !== 'string' || !sourceSet.has(source)) continue
      }
      if (filters.search && !entry.msg.includes(filters.search)) continue
      if (filters.from && entry.time < filters.from) continue
      if (filters.to && entry.time > filters.to) continue
      if (filters.runId && entry.extras?.runId !== filters.runId) continue
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
