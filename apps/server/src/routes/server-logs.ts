import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { type ServerLogEntry, ServerLogFiltersSchema, ServerLogLevelSchema } from '@ia-flow/shared'
import { Hono } from 'hono'
import { createLogger } from '../logger.js'

const log = createLogger('server-logs')

const DEFAULT_LIMIT = 200
const MAX_LIMIT = 1000
// Cuánto log se lee como máximo por request, sumando archivos si la ventana
// cruza una rotación. Mantiene acotada la memoria de un daemon de días.
//
// Antes había además un LARGE_FILE_BYTES ("por encima de esto, tailear en vez
// de leer entero"): con el archivo rotando ya no puede existir uno más grande
// que IA_FLOW_LOG_MAX_SIZE, así que el umbral no disparaba nunca. Ahora el
// recorte se decide siempre contra el presupuesto que queda.
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
 * Los archivos de log, del MÁS NUEVO al más viejo.
 *
 * Desde que el sink rota (pino-roll, ver logger.ts) el nombre lleva un
 * contador: `daemon.1.log`, `daemon.2.log`, … El activo es el de número más
 * alto, no el de mtime más reciente — un `touch` o un rsync sobre uno viejo no
 * debería redirigir la lectura.
 *
 * Se devuelven todos, no sólo el activo, porque el visor tiene que seguir
 * mostrando una ventana de tamaño estable: justo después de una rotación el
 * archivo activo arranca vacío, y leer sólo ése dejaría la UI casi en blanco
 * con los últimos minutos intactos en el anterior. `readLogText` los recorre
 * hacia atrás hasta juntar TAIL_BYTES.
 *
 * Cierra con `daemon.log` si existe: es el archivo que dejó cualquier
 * instalación anterior a la rotación, y es el más viejo de todos.
 */
function resolveLogFiles(): string[] {
  const dir = resolveLogDir()
  const rolled: Array<{ n: number; name: string }> = []
  let legacy = false
  try {
    for (const name of readdirSync(dir)) {
      if (name === 'daemon.log') {
        legacy = true
        continue
      }
      const n = rollNumber(name)
      if (n != null) rolled.push({ n, name })
    }
  } catch {
    // Directorio inexistente (primer arranque): la lista queda vacía y los
    // llamadores devuelven vacío en vez de romper.
    return []
  }
  rolled.sort((a, b) => b.n - a.n)
  const files = rolled.map((f) => join(dir, f.name))
  if (legacy) files.push(join(dir, 'daemon.log'))
  return files
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

/**
 * El final de UN archivo: entero si entra en `budget`, si no sus últimos
 * `budget` bytes. Al recortar se descarta la primera línea, que casi seguro
 * quedó cortada al medio y produciría una entrada corrupta.
 *
 * Devuelve también los bytes consumidos, no sólo el texto: descontar del
 * presupuesto con `text.length` mezclaría caracteres con bytes, y con UTF-8
 * multibyte (los acentos y los guiones largos que estos logs tienen de sobra)
 * la ventana se pasaría del techo.
 */
async function readFileTail(
  file: string,
  budget: number,
): Promise<{ text: string; bytes: number }> {
  const size = statSync(file).size
  if (size <= budget) return { text: readFileSync(file, 'utf8'), bytes: size }
  const text = await Bun.file(file)
    .slice(size - budget, size)
    .text()
  const nl = text.indexOf('\n')
  return { text: nl === -1 ? '' : text.slice(nl + 1), bytes: budget }
}

/**
 * La ventana que el visor lee: los últimos ~TAIL_BYTES de log, cruzando la
 * frontera de rotación si hace falta.
 *
 * Camina de nuevo a viejo gastando presupuesto y devuelve el resultado en
 * orden cronológico (viejo → nuevo), que es el que el resto de la ruta asume:
 * `entries` se arma en orden de lectura y se pagina sobre eso.
 *
 * Leer un solo archivo alcanzaba cuando había uno solo que crecía sin techo;
 * con rotación cada archivo está acotado a IA_FLOW_LOG_MAX_SIZE, así que el
 * recién rotado puede tener 200 bytes y toda la historia útil vivir en el
 * anterior.
 */
async function readLogText(): Promise<string> {
  const chunks: string[] = []
  let budget = TAIL_BYTES
  for (const file of resolveLogFiles()) {
    if (budget <= 0) break
    if (!existsSync(file)) continue
    const { text, bytes } = await readFileTail(file, budget)
    budget -= bytes
    if (text) chunks.push(text)
  }
  return chunks.reverse().join('')
}

// Cheap read of the full log to collect distinct module names. Used by the
// UI to show every module ever emitted as a multi-select chip, not just the
// ones on the current page. Bounded by the same tail behavior as the main
// query so an ever-growing log stays cheap.
async function readAllModules(): Promise<string[]> {
  let text: string
  try {
    text = await readLogText()
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
  let text: string
  try {
    text = await readLogText()
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

/** Normaliza un filtro multi-select a un Set. Un `?campo=` sin valor no filtra
 *  nada — si no, un query mal armado vaciaría el listado en silencio. */
function toSet(raw: string | string[] | undefined): Set<string> | null {
  if (!raw) return null
  const cleaned = (Array.isArray(raw) ? raw : [raw])
    .map((v) => v.trim())
    .filter((v) => v.length > 0)
  return cleaned.length > 0 ? new Set(cleaned) : null
}

function matchesExtra(entry: ServerLogEntry, key: string, allowed: Set<string>): boolean {
  const value = entry.extras?.[key]
  return typeof value === 'string' && allowed.has(value)
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
    // Un solo valor llega como string y varios como array — la forma que
    // `ServerLogFiltersSchema` acepta para todos los multi-select.
    const multi = (key: string): string | string[] | undefined => {
      const values = c.req.queries(key) ?? []
      return values.length > 1 ? values : (values[0] ?? q[key])
    }
    const parsed = ServerLogFiltersSchema.safeParse({
      level: q.level,
      module: multi('module'),
      source: multi('source'),
      search: q.search,
      from: q.from,
      to: q.to,
      limit: rawLimit !== undefined && Number.isNaN(rawLimit) ? undefined : rawLimit,
      offset: rawOffset !== undefined && Number.isNaN(rawOffset) ? undefined : rawOffset,
      sort: q.sort,
      sortBy: q.sortBy,
      runId: multi('runId'),
      projectId: multi('projectId'),
      agentId: multi('agentId'),
      taskId: multi('taskId'),
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
    const moduleSet = toSet(filters.module)
    // Los cinco filtros sobre `extras` son el MISMO predicado con otra clave, así
    // que se arman como una lista: agregar uno nuevo es una línea acá y una en
    // el schema, no otra rama en el loop de abajo.
    const extraSets: Array<[string, Set<string>]> = []
    for (const [key, raw] of [
      ['source', filters.source],
      ['runId', filters.runId],
      ['projectId', filters.projectId],
      ['agentId', filters.agentId],
      ['taskId', filters.taskId],
    ] as const) {
      const set = toSet(raw)
      if (set) extraSets.push([key, set])
    }

    // Sin archivos, `readLogText` devuelve '' y todo lo de abajo produce
    // exactamente la respuesta vacía que antes se armaba a mano acá.
    let text: string
    try {
      text = await readLogText()
    } catch (err) {
      log.error({ err, files: resolveLogFiles() }, 'failed to read the daemon log')
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
      // Una línea sin el campo NO entra: la infraestructura no pertenece a
      // ningún agente ni a ninguna tarea, y preguntar por una es pedir
      // explícitamente lo que sí tiene dueño.
      if (extraSets.some(([key, set]) => !matchesExtra(entry, key, set))) continue
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
