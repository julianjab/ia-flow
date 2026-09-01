// El motor de un filtro `campo:valor`, aparte del componente.
//
// La UI de filtros de Ejecuciones y de Logs era una pila de grupos de chips —uno
// por dimensión, cada uno con su buscador y su "+N más"— que crecía con cada
// columna nueva y ocupaba media pantalla antes de la primera fila. Un solo input
// que autocompleta primero el CAMPO y después su VALOR dice lo mismo en un
// renglón, y agregar una dimensión es una entrada más en un array.
//
// Vive fuera del `.vue` porque es lo único que tiene reglas propias —qué se
// sugiere, qué se acepta, cómo se normaliza— y así se testea sin montar nada ni
// simular teclas.

/**
 * Un valor sugerible. La forma con `label` existe para cuando lo que el filtro
 * manda no es lo que el operador reconoce —el id de un proyecto contra su
 * nombre—: se busca y se muestra por `label`, se filtra por `value`.
 */
export type FilterValue = string | { value: string; label: string }

/** Un campo filtrable. Sin `values` es texto libre (una fecha, un substring). */
export type FilterFieldDef = {
  key: string
  /** Qué filtra, para el menú. No es el nombre: el nombre es `key`, que es lo
   *  que el operador escribe. */
  hint?: string
  values?: FilterValue[]
  /** Acepta valores fuera de `values`. Sin `values` siempre es libre. */
  free?: boolean
  /**
   * Qué es un valor aceptable, para un campo libre. Sin esto, `desde:ayer`
   * entraba como token y el `new Date(...)` de la consulta tiraba — el panel
   * quedaba en "Invalid time value" y ningún resultado cargaba hasta borrar el
   * token, sin nada que señalara a la fecha.
   *
   * Un campo con lista cerrada no lo necesita: la lista ES su validación.
   */
  validate?: (value: string) => boolean
}

export type FilterToken = { field: string; value: string }

export type Suggestion = {
  kind: 'field' | 'value'
  value: string
  /** Lo que se muestra. Igual a `value` salvo que el campo traiga etiquetas. */
  label: string
  hint?: string
}

function rawValue(v: FilterValue): string {
  return typeof v === 'string' ? v : v.value
}
function rawLabel(v: FilterValue): string {
  return typeof v === 'string' ? v : v.label
}

/** Parte el borrador en campo y término. El primer `:` manda: un valor puede
 *  traer los suyos (`remote:mac-studio`, una hora) y partir por el último
 *  rompería justo esos. */
export function splitDraft(draft: string): { field: string | null; term: string } {
  const at = draft.indexOf(':')
  if (at < 0) return { field: null, term: draft.trim() }
  return { field: draft.slice(0, at).trim(), term: draft.slice(at + 1).trim() }
}

function findField(fields: FilterFieldDef[], key: string): FilterFieldDef | undefined {
  const needle = key.toLowerCase()
  return fields.find((f) => f.key.toLowerCase() === needle)
}

/** Cómo se muestra un valor ya elegido. Sin etiqueta, el valor mismo — y
 *  también cuando el valor ya no está en la lista (un proyecto borrado con su
 *  token todavía puesto). */
export function labelForToken(fields: FilterFieldDef[], token: FilterToken): string {
  const match = findField(fields, token.field)?.values?.find((v) => rawValue(v) === token.value)
  return match ? rawLabel(match) : token.value
}

type Candidate = { value: string; label: string }

/** Lo primero que empieza con el término, después lo que lo contiene. Es el
 *  orden en que uno busca: escribir `re` pone `refiner` antes que `pr-reviewer`.
 *
 *  Matchea contra la etiqueta Y contra el valor: quien conoce el id lo puede
 *  tipear igual, aunque en pantalla vea el nombre. */
function rank(candidates: Candidate[], term: string): Candidate[] {
  const needle = term.toLowerCase()
  if (!needle) return candidates
  const starts: Candidate[] = []
  const contains: Candidate[] = []
  for (const c of candidates) {
    const label = c.label.toLowerCase()
    const value = c.value.toLowerCase()
    if (label.startsWith(needle) || value.startsWith(needle)) starts.push(c)
    else if (label.includes(needle) || value.includes(needle)) contains.push(c)
  }
  return [...starts, ...contains]
}

/**
 * Qué ofrecer para el borrador actual.
 *
 * Sin `:` se ofrecen CAMPOS; con `:` los valores de ese campo. Un campo de texto
 * libre no ofrece nada: no hay lista que mostrar y un menú vacío tapando la
 * escritura es peor que ninguno.
 *
 * Los valores ya usados no se ofrecen: dos tokens iguales filtrarían lo mismo
 * dos veces y sólo dan trabajo para borrar.
 */
export function suggest(
  draft: string,
  fields: FilterFieldDef[],
  tokens: FilterToken[] = [],
): Suggestion[] {
  const { field, term } = splitDraft(draft)
  if (field === null) {
    return rank(
      fields.map((f) => ({ value: f.key, label: f.key })),
      term,
    ).map((c) => ({
      kind: 'field',
      value: c.value,
      label: c.label,
      hint: findField(fields, c.value)?.hint,
    }))
  }
  const def = findField(fields, field)
  if (!def?.values) return []
  const used = new Set(
    tokens.filter((t) => t.field.toLowerCase() === field.toLowerCase()).map((t) => t.value),
  )
  return rank(
    def.values
      .filter((v) => !used.has(rawValue(v)))
      .map((v) => ({ value: rawValue(v), label: rawLabel(v) })),
    term,
  ).map((c) => ({ kind: 'value', value: c.value, label: c.label }))
}

/**
 * El token que cierra este borrador, o `null` si todavía no cierra ninguno.
 *
 * Un campo con lista cerrada NO acepta lo que no está en ella: el valor se
 * normaliza contra la lista (así `ERROR` entra como `error`, y el nombre de un
 * proyecto entra como su id) y si no matchea no hay token — filtrar por un valor
 * que no existe devuelve vacío sin decir por qué, que es la peor forma de fallar
 * en un filtro.
 */
export function tokenFromDraft(
  draft: string,
  fields: FilterFieldDef[],
  defaultField?: string,
): FilterToken | null {
  const split = splitDraft(draft)
  let field = split.field
  let term = split.term
  // Sin `:` es texto plano. Con un campo default (`msg` en Logs, `tarea` en
  // Ejecuciones) se trata como si lo hubiera escrito: así "timeout" filtra
  // igual que "msg:timeout", sin obligar a nombrar el campo para el caso más
  // común. Sin default, texto plano sigue sin ser un token — es el mismo
  // borrador que ofrece campos en el menú.
  if (field === null) {
    if (!defaultField) return null
    field = defaultField
    term = draft.trim()
  }
  if (!term) return null
  const def = findField(fields, field)
  if (!def) return null
  // Lo escrito puede ser el valor o la etiqueta: los dos se ven en el menú.
  const exact = def.values?.find(
    (v) =>
      rawValue(v).toLowerCase() === term.toLowerCase() ||
      rawLabel(v).toLowerCase() === term.toLowerCase(),
  )
  if (!def.values || def.free) {
    const value = exact ? rawValue(exact) : term
    // Rechazar es lo mismo que hace una lista cerrada con un valor que no está:
    // no hay token, lo escrito sigue en el input y no se consulta nada.
    return def.validate && !def.validate(value) ? null : { field: def.key, value }
  }
  return exact ? { field: def.key, value: rawValue(exact) } : null
}

export function formatToken(token: FilterToken): string {
  return `${token.field}:${token.value}`
}

/** Agrega sin duplicar. Dos tokens iguales no acotan nada. */
export function addToken(tokens: FilterToken[], token: FilterToken): FilterToken[] {
  const dup = tokens.some((t) => t.field === token.field && t.value === token.value)
  return dup ? tokens : [...tokens, token]
}

/**
 * `AAAA-MM-DD`, opcionalmente con hora (`T HH:mm` o `HH:mm:ss`), y que exista de
 * verdad — `2025-02-31` matchea el formato pero no es un día.
 *
 * Vive acá y no en cada sección porque las dos filtran por fecha y el import
 * cruzado entre features está prohibido.
 */
export function isDateValue(raw: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?$/.test(raw)) return false
  const [date] = raw.split(/[T ]/)
  const [y, m, d] = date.split('-').map(Number)
  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) return false
  // Un mes 13 o un 31 de febrero se desbordan al mes siguiente en vez de fallar.
  const asUtc = new Date(Date.UTC(y, m - 1, d))
  return asUtc.getUTCMonth() === m - 1 && asUtc.getUTCDate() === d
}
