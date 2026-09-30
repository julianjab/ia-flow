/**
 * Una traza leída por páginas, con los campos que se piden. Una ejecución puede tener cientos de
 * entradas y cada una trae el prompt, el input y el resultado de una tool (hasta 10 KB cada uno):
 * volcarla entera y cortar dejaba al modelo con el principio y sin el final, que es donde está
 * cómo terminó. Acá nada se corta: la página se llena hasta un presupuesto y `next_offset` dice
 * dónde sigue. Puro, sin I/O.
 */
import type { TraceEntry } from '@ia-flow/shared'

/** Lo que ocupa, como mucho, una página serializada — debajo del tope de un tool result. */
export const TRACE_PAGE_CHARS = 14_000
export const TRACE_PAGE_LIMIT = 50
export const TRACE_PAGE_MAX_LIMIT = 200

/** Los campos de una entrada, sin `attributes`: ésos se piden enteros o de a uno. */
const ENTRY_FIELDS = {
  at: (entry: TraceEntry) => entry.start_time,
  end_time: (entry: TraceEntry) => entry.end_time,
  duration_ms: (entry: TraceEntry) => entry.duration_ms,
  kind: (entry: TraceEntry) => entry.kind,
  phase: (entry: TraceEntry) => entry.phase,
  name: (entry: TraceEntry) => entry.name,
  scope: (entry: TraceEntry) => entry.scope,
  level: (entry: TraceEntry) => entry.level,
  status: (entry: TraceEntry) => entry.status,
  status_message: (entry: TraceEntry) => entry.status_message,
  span_id: (entry: TraceEntry) => entry.span_id,
  parent_span_id: (entry: TraceEntry) => entry.parent_span_id,
  origin: (entry: TraceEntry) => entry.origin,
  /** Atajo del atributo que más se busca: qué tool corrió. */
  tool: (entry: TraceEntry) => entry.attributes['gen_ai.tool.name'],
} satisfies Record<string, (entry: TraceEntry) => unknown>

export type TraceField = keyof typeof ENTRY_FIELDS
export const TRACE_FIELDS = Object.keys(ENTRY_FIELDS) as TraceField[]

/** Sin `fields`: lo que alcanza para ver qué pasó, en orden, sin los payloads. */
export const DEFAULT_TRACE_FIELDS: readonly string[] = [
  'at',
  'kind',
  'name',
  'tool',
  'status',
  'level',
]

const ATTRIBUTE_PREFIX = 'attributes.'

export interface TracePageQuery {
  offset?: number
  limit?: number
  /** Campos de `TRACE_FIELDS`, `attributes` (todos) o `attributes.<clave>` (uno). */
  fields?: readonly string[]
  /** Sólo las entradas cuyo nombre o atributos contienen esto (sin distinguir mayúsculas). */
  contains?: string
}

export interface TracePage {
  execution_id: string
  /** Entradas de la ejecución. */
  total: number
  /** Las que pasan `contains` (igual a `total` sin filtro). */
  matched: number
  offset: number
  returned: number
  /** Desde dónde pedir la próxima página, o `null` si no hay más. */
  next_offset: number | null
  /** Las claves de atributo de las entradas que pasan el filtro, para pedirlas en `fields`. */
  attribute_keys: string[]
  /** `index` es la posición en la ejecución (0 = la primera), también con filtro. */
  entries: Array<Record<string, unknown>>
}

/** Un campo que no existe es un error que el modelo lee y corrige, no un campo vacío. */
export function validateTraceFields(fields: readonly string[]): void {
  const unknown = fields.filter(
    (field) =>
      field !== 'attributes' &&
      !field.startsWith(ATTRIBUTE_PREFIX) &&
      !(TRACE_FIELDS as string[]).includes(field),
  )
  if (unknown.length > 0) {
    throw new Error(
      `Campos desconocidos: ${unknown.join(', ')}. Hay: ${TRACE_FIELDS.join(', ')}, attributes, attributes.<clave>`,
    )
  }
}

/** La entrada con sólo los campos pedidos; los que no tiene no aparecen. */
export function projectTraceEntry(
  entry: TraceEntry,
  index: number,
  fields: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = { index }
  for (const field of fields) {
    if (field === 'attributes') {
      out.attributes = entry.attributes
      continue
    }
    if (field.startsWith(ATTRIBUTE_PREFIX)) {
      const key = field.slice(ATTRIBUTE_PREFIX.length)
      if (key in entry.attributes) {
        const attributes = (out.attributes ?? {}) as Record<string, unknown>
        attributes[key] = entry.attributes[key]
        out.attributes = attributes
      }
      continue
    }
    const value = ENTRY_FIELDS[field as TraceField]?.(entry)
    if (value !== undefined) out[field] = value
  }
  return out
}

function matches(entry: TraceEntry, needle: string): boolean {
  return JSON.stringify([entry.name, entry.status_message, entry.attributes])
    .toLowerCase()
    .includes(needle)
}

/**
 * Una página de la traza. Se llena en orden hasta `limit` entradas o `TRACE_PAGE_CHARS`, lo que
 * llegue primero — pero siempre con al menos una, aunque sola se pase: cortarla es justo lo que
 * esto evita.
 */
export function traceWindow(
  executionId: string,
  entries: readonly TraceEntry[],
  query: TracePageQuery = {},
): TracePage {
  const fields = query.fields?.length ? query.fields : DEFAULT_TRACE_FIELDS
  validateTraceFields(fields)
  const limit = Math.min(Math.max(query.limit ?? TRACE_PAGE_LIMIT, 1), TRACE_PAGE_MAX_LIMIT)
  const offset = Math.max(query.offset ?? 0, 0)
  const needle = query.contains?.trim().toLowerCase()

  const indexed = entries.map((entry, index) => ({ entry, index }))
  const matched = needle ? indexed.filter(({ entry }) => matches(entry, needle)) : indexed

  const page: Array<Record<string, unknown>> = []
  let chars = 0
  let cursor = offset
  while (cursor < matched.length && page.length < limit) {
    const { entry, index } = matched[cursor] as { entry: TraceEntry; index: number }
    const projected = projectTraceEntry(entry, index, fields)
    const size = JSON.stringify(projected).length + 1
    if (page.length > 0 && chars + size > TRACE_PAGE_CHARS) break
    page.push(projected)
    chars += size
    cursor++
  }

  return {
    execution_id: executionId,
    total: entries.length,
    matched: matched.length,
    offset,
    returned: page.length,
    next_offset: cursor < matched.length ? cursor : null,
    attribute_keys: [...new Set(matched.flatMap(({ entry }) => Object.keys(entry.attributes)))],
    entries: page,
  }
}
