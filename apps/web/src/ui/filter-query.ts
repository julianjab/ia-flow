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

/** Un campo filtrable. Sin `values` es texto libre (una fecha, un substring). */
export type FilterFieldDef = {
  key: string
  /** Qué filtra, para el menú. No es el nombre: el nombre es `key`, que es lo
   *  que el operador escribe. */
  hint?: string
  values?: string[]
  /** Acepta valores fuera de `values`. Sin `values` siempre es libre. */
  free?: boolean
}

export type FilterToken = { field: string; value: string }

export type Suggestion = { kind: 'field' | 'value'; value: string; hint?: string }

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

/** Lo primero que empieza con el término, después lo que lo contiene. Es el
 *  orden en que uno busca: escribir `re` pone `refiner` antes que `pr-reviewer`. */
function rank(candidates: string[], term: string): string[] {
  const needle = term.toLowerCase()
  if (!needle) return candidates
  const starts: string[] = []
  const contains: string[] = []
  for (const c of candidates) {
    const lc = c.toLowerCase()
    if (lc.startsWith(needle)) starts.push(c)
    else if (lc.includes(needle)) contains.push(c)
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
      fields.map((f) => f.key),
      term,
    ).map((key) => ({ kind: 'field', value: key, hint: findField(fields, key)?.hint }))
  }
  const def = findField(fields, field)
  if (!def?.values) return []
  const used = new Set(
    tokens.filter((t) => t.field.toLowerCase() === field.toLowerCase()).map((t) => t.value),
  )
  return rank(
    def.values.filter((v) => !used.has(v)),
    term,
  ).map((value) => ({ kind: 'value', value }))
}

/**
 * El token que cierra este borrador, o `null` si todavía no cierra ninguno.
 *
 * Un campo con lista cerrada NO acepta lo que no está en ella: el valor se
 * normaliza contra la lista (así `ERROR` entra como `error`) y si no matchea no
 * hay token — filtrar por un valor que no existe devuelve vacío sin decir por
 * qué, que es la peor forma de fallar en un filtro.
 */
export function tokenFromDraft(draft: string, fields: FilterFieldDef[]): FilterToken | null {
  const { field, term } = splitDraft(draft)
  if (field === null || !term) return null
  const def = findField(fields, field)
  if (!def) return null
  if (!def.values || def.free) {
    const exact = def.values?.find((v) => v.toLowerCase() === term.toLowerCase())
    return { field: def.key, value: exact ?? term }
  }
  const exact = def.values.find((v) => v.toLowerCase() === term.toLowerCase())
  return exact ? { field: def.key, value: exact } : null
}

export function formatToken(token: FilterToken): string {
  return `${token.field}:${token.value}`
}

/** Agrega sin duplicar. Dos tokens iguales no acotan nada. */
export function addToken(tokens: FilterToken[], token: FilterToken): FilterToken[] {
  const dup = tokens.some((t) => t.field === token.field && t.value === token.value)
  return dup ? tokens : [...tokens, token]
}
