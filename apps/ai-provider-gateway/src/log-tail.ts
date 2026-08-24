// Leer el final del archivo de log — lo que la pantalla muestra en su card
// de logs (`GET /v1/logs`).
//
// Vive aparte de logger.ts porque son las dos mitades opuestas del archivo:
// aquél lo escribe y no lo lee nunca; éste lo lee y no lo escribe nunca.
// Todo lo que decide qué línea se ve es puro (`matchLine`, `tailFrom`), así
// que el filtro se testea sin crear un archivo.
import type { Log } from './logger.js'

/** Cuánto del final del archivo se mira. Un log de meses no entra en RAM y
 *  nadie busca ahí con un tail: lo que no entra se reporta como `truncated`
 *  para que la pantalla lo diga en vez de mentir un "no hay resultados". */
export const SCAN_BYTES = 4 * 1024 * 1024

/** Techo de líneas por respuesta — el default lo pide el cliente. */
export const MAX_LIMIT = 2000

export interface LogLine {
  /** La línea cruda. Es lo que se muestra si no parsea como JSON de pino. */
  raw: string
  time?: string
  level?: number
  scope?: string
  msg?: string
  /** Todo lo demás que traía la línea, para el detalle expandido. */
  extras?: Record<string, unknown>
}

export interface LogTail {
  /** `null` = este gateway corre sin archivo (ver logger.ts). */
  file: string | null
  lines: LogLine[]
  /** El filtro no alcanzó a mirar todo el archivo: hay historia más vieja
   *  que la ventana de `SCAN_BYTES`. */
  truncated: boolean
}

const IGNORED_KEYS = new Set(['time', 'level', 'msg', 'scope', 'pid', 'hostname'])

/** Case- e acento-insensible: el filtro se tipea a mano mirando la pantalla,
 *  y no matchear una palabra que está a la vista se lee como "no está". */
function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
}

export const LEVEL_NAMES: Record<number, string> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
}

const LEVEL_WORDS = new Set(Object.values(LEVEL_NAMES))

/** El nivel sin parsear la línea entera. Vale la pena el regex: parsear cada
 *  línea de una ventana de 4 MB para descartarla es caro, y sólo hace falta
 *  cuando el filtro nombra un nivel. */
function levelWord(line: string): string {
  const match = /"level"\s*:\s*(\d+)/.exec(line)
  return match ? (LEVEL_NAMES[Number(match[1])] ?? '') : ''
}

/**
 * Si una línea responde al filtro.
 *
 * Cada término tiene que estar: `error tmux` **acota** en vez de ampliar,
 * que es cómo se usa una segunda palabra cuando la primera dejó demasiado.
 * Matchea contra la línea CRUDA, no contra los campos parseados: buscar
 * `taskId` o un id que sólo vive en los extras es la mitad de las búsquedas.
 *
 * La excepción es el nivel, que en el archivo es un número (`"level":50`):
 * buscar `error` —lo primero que alguien tipea— no encontraba un solo error.
 * Cuando un término es un nombre de nivel, se busca también contra él.
 */
export function matchLine(query: string, line: string): boolean {
  const terms = fold(query)
    .split(/\s+/)
    .filter((t) => t.length > 0)
  if (terms.length === 0) return true
  const haystack = terms.some((t) => LEVEL_WORDS.has(t))
    ? fold(line) + ' ' + levelWord(line)
    : fold(line)
  return terms.every((term) => haystack.includes(term))
}

function parseLine(raw: string): LogLine {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>
    if (!obj || typeof obj !== 'object') return { raw }
    const extras: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) if (!IGNORED_KEYS.has(k)) extras[k] = v
    return {
      raw,
      time: typeof obj.time === 'string' ? obj.time : undefined,
      level: typeof obj.level === 'number' ? obj.level : undefined,
      scope: typeof obj.scope === 'string' ? obj.scope : undefined,
      msg: typeof obj.msg === 'string' ? obj.msg : undefined,
      extras: Object.keys(extras).length ? extras : undefined,
    }
  } catch {
    // Una línea a medio escribir (el logger estaba en el medio del write) o
    // algo que no es JSON: se muestra cruda en vez de desaparecer.
    return { raw }
  }
}

/**
 * Las últimas `limit` líneas que pasan el filtro, en orden cronológico.
 *
 * Se recorre desde el final y se corta al juntar `limit`: filtrar DESPUÉS de
 * recortar a las últimas N daría casi siempre vacío — buscar "error" en un
 * log ruidoso sólo encontraría los errores que entraron en la última página,
 * que es justo lo que uno no está buscando.
 */
export function tailFrom(text: string, limit: number, query = ''): LogLine[] {
  const lines = text.split('\n')
  const out: LogLine[] = []
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const raw = lines[i]?.trim()
    if (!raw) continue
    if (!matchLine(query, raw)) continue
    out.push(parseLine(raw))
  }
  return out.reverse()
}

export interface ReadLogTailDeps {
  /** Inyectado para poder testear sin disco y para que este módulo no decida
   *  dónde está el archivo — eso es de logger.ts. */
  file: string | null
  limit: number
  query?: string
  log?: Log
}

export async function readLogTail({ file, limit, query, log }: ReadLogTailDeps): Promise<LogTail> {
  if (!file) return { file: null, lines: [], truncated: false }

  const capped = Math.min(Math.max(1, limit), MAX_LIMIT)
  const handle = Bun.file(file)

  // Un archivo que todavía no existe no es un error: el gateway acaba de
  // arrancar y el logger escribe en su primer flush.
  if (!(await handle.exists())) return { file, lines: [], truncated: false }

  const size = handle.size
  const from = Math.max(0, size - SCAN_BYTES)
  let text: string
  try {
    text = await handle.slice(from).text()
  } catch (err) {
    // El archivo puede estar rotando, o el proceso puede haber perdido el
    // permiso: la pantalla sigue viva mostrando el resto de las cards.
    log?.warn({ file, reason: String(err) }, 'no pude leer el archivo de log')
    return { file, lines: [], truncated: false }
  }

  // Arrancando a mitad del archivo, el primer renglón está cortado: mostrarlo
  // sería una línea inventada.
  if (from > 0) text = text.slice(text.indexOf('\n') + 1)

  return { file, lines: tailFrom(text, capped, query), truncated: from > 0 }
}
