import { groupWhenArray } from '@ia-flow/rules'

// El traductor de GitHub dejó de inventar nombres de evento (`pr.opened`,
// `ci.finished`, `issues.<action>`, …) — ver `webhook-events.ts`.
// `EngineEvent.type` para un webhook de GitHub es ahora EXACTAMENTE el
// nombre crudo (`pull_request`, `check_suite`, `issues`, …), y `action` se
// filtra con `when`. Este módulo es la traducción compartida de una regla
// (o espera) que todavía usa la taxonomía vieja — la usan DOS callers que no
// se conocen entre sí:
//
//   - la migración `080-raw-github-event-types.ts`, sobre las filas de
//     `rules`/`waits` en SQLite (escribe el resultado, una vez).
//   - `YamlRuleRepository`, sobre las reglas de un `runner.yaml` de deploy
//     headless — esas NO pasan por SQLite ni por ninguna migración, así que
//     sin esto quedan calladas para siempre: el traductor ya no publica los
//     tipos viejos y nada en el YAML avisa.
//
// **Cross-product, no concatenar.** Agregar la condición de `action` pegándola
// al final del `when` existente rompería cualquier fila con más de un grupo
// OR (el nuevo grupo quedaría sin las condiciones previas) o cualquier tipo
// curado con más de una `action` posible (`pr.opened` → opened/reopened: la
// rama `reopened` quedaría sin las condiciones existentes). `groupWhenArray`
// (`@ia-flow/rules`) es el mismo algoritmo de agrupación OR/AND que usa el
// evaluador, para no poder divergir de cómo el motor va a leer el resultado.
//
// **`pr.merged`/`pr.closed` sí son expresables**: `pr.merged` → `pull_request`
// con `[action=closed, pr.merged=true]`; `pr.closed` → `[action=closed,
// pr.merged=false]`; si una regla tiene LOS DOS, se colapsan en
// `[action=closed]` sola (juntos cubren todo `closed`, sin necesidad del
// flag).
//
// Lo que sigue sin auto-traducirse (`skip: true`, con el motivo — el caller
// decide qué hacer: loguear, rechazar, lo que corresponda a su contexto):
//   - `when` en formato Record legacy (`{additions: '$gt:500'}`) — convertirlo
//     exige el parser de `$op:valor` de `packages/rules/src/when.ts`, no
//     expuesto, y es un caso que hoy no se vio en ninguna regla real.
//   - Una fila cuyo `on` mezcla tipos curados que requieren `action`
//     DISTINTA, o un tipo curado con uno NO curado — ver `canAutoTranslate`:
//     el `when` evalúa contra `event.payload`, que no lleva el tipo del
//     evento, así que una condición de `action` compartida no puede
//     distinguir de qué tipo vino cada delivery.

export interface RawCond {
  field: string
  op: string
  value?: string
  logic?: 'and' | 'or'
}

interface SimpleMapping {
  kind: 'simple'
  rawTypes: string[]
  actions: string[]
}
/** `pr.merged`/`pr.closed`: necesitan `pr.merged` además de `action`, y su
 *  requirement se decide mirando el resto de `on` (ver `mergedClosedGroups`),
 *  no de forma aislada por tipo. */
type Mapping = SimpleMapping | { kind: 'merged_or_closed'; merged: boolean }

const STATIC_MAPPING: Record<string, Mapping> = {
  'pr.opened': { kind: 'simple', rawTypes: ['pull_request'], actions: ['opened', 'reopened'] },
  'pr.synchronize': { kind: 'simple', rawTypes: ['pull_request'], actions: ['synchronize'] },
  'pr.ready_for_review': {
    kind: 'simple',
    rawTypes: ['pull_request'],
    actions: ['ready_for_review'],
  },
  'pr.review_submitted': {
    kind: 'simple',
    rawTypes: ['pull_request_review'],
    actions: ['submitted'],
  },
  'ci.finished': {
    kind: 'simple',
    rawTypes: ['check_suite', 'workflow_run'],
    actions: ['completed'],
  },
  'pr.merged': { kind: 'merged_or_closed', merged: true },
  'pr.closed': { kind: 'merged_or_closed', merged: false },
}

/** `issue_comment.<action>` / `issues.<action>` / `projects_v2_item.<action>`
 *  / `projects_v2.<action>` — el sufijo YA es la acción tal cual GitHub la
 *  manda, así que la traducción es directa: el prefijo es el tipo crudo. */
const DYNAMIC_PREFIXES = ['issue_comment', 'issues', 'projects_v2_item', 'projects_v2']

function mappingFor(type: string): Mapping | null {
  const staticHit = STATIC_MAPPING[type]
  if (staticHit) return staticHit

  for (const prefix of DYNAMIC_PREFIXES) {
    if (type.startsWith(`${prefix}.`)) {
      const action = type.slice(prefix.length + 1)
      if (action) return { kind: 'simple', rawTypes: [prefix], actions: [action] }
    }
  }
  return null
}

/** Si algún tipo de la lista usa la taxonomía vieja — el chequeo barato que
 *  un caller hace ANTES de construir nada, para no tocar la regla común
 *  (`issue.status_changed`, ya en nombre crudo) sin necesidad. */
export function usesLegacyTaxonomy(types: readonly string[]): boolean {
  return types.some((t) => mappingFor(t) !== null)
}

function rawTypeSetOf(mapping: Mapping): string {
  const types = mapping.kind === 'simple' ? mapping.rawTypes : ['pull_request']
  return [...types].sort().join(',')
}

/**
 * Si es seguro inyectar UN `when` compartido para toda la fila.
 *
 * El `when` de una regla evalúa contra `event.payload`, que no lleva el
 * TIPO del evento (`match.ts`: el subject es `event.payload`, nunca
 * `event.type`) — así que una condición de `action` no puede distinguir
 * "esta acción, pero sólo si el evento era `pull_request`" de "esta acción,
 * venga de donde venga". Mezclar tipos curados con requisitos de `action`
 * DISTINTOS (`issues.opened` + `pr.synchronize`) o con un tipo NO curado
 * (`pr.opened` + `issue.status_changed`, que no tiene campo `action`) deja
 * una fila que dispara de más o de menos según el caso — ninguno de los dos
 * silenciosamente, así que mejor no tocarla.
 *
 * Seguro sólo cuando TODOS los tipos de la fila son curados y TODOS
 * apuntan al mismo conjunto de tipos crudos (p. ej. `pr.opened` +
 * `pr.synchronize` + `pr.merged`, los tres → sólo `pull_request`; o
 * `ci.finished` sola, que ya mapea a dos tipos crudos A PROPÓSITO porque
 * son el mismo hecho).
 */
function canAutoTranslate(types: readonly string[]): boolean {
  const mappings = types.map(mappingFor)
  if (mappings.some((m) => m === null)) return false
  const sets = new Set(mappings.map((m) => rawTypeSetOf(m as Mapping)))
  return sets.size === 1
}

/** El o los grupos que `pr.merged`/`pr.closed` aportan, colapsando el caso de
 *  que una regla tenga LOS DOS: juntos cubren todo `action=closed`, así que
 *  el flag `pr.merged` deja de hacer falta. */
function mergedClosedGroups(types: readonly string[]): RawCond[][] {
  const hasMerged = types.includes('pr.merged')
  const hasClosed = types.includes('pr.closed')
  if (hasMerged && hasClosed) return [[{ field: 'action', op: '=', value: 'closed' }]]
  if (hasMerged) {
    return [
      [
        { field: 'action', op: '=', value: 'closed' },
        { field: 'pr.merged', op: '=', value: 'true' },
      ],
    ]
  }
  if (hasClosed) {
    return [
      [
        { field: 'action', op: '=', value: 'closed' },
        { field: 'pr.merged', op: '=', value: 'false' },
      ],
    ]
  }
  return []
}

/** Los grupos OR que reemplazan el filtro por `action` que hacía el
 *  traductor — uno por valor posible, salvo `pr.merged`/`pr.closed` que
 *  aportan su propio grupo compuesto (ver `mergedClosedGroups`). */
function requirementGroups(types: readonly string[]): RawCond[][] {
  const groups: RawCond[][] = []
  for (const t of types) {
    const mapping = mappingFor(t)
    if (mapping?.kind !== 'simple') continue
    for (const value of mapping.actions) groups.push([{ field: 'action', op: '=', value }])
  }
  groups.push(...mergedClosedGroups(types))
  // Dedup: dos tipos curados distintos (p. ej. `issues.opened` y otro que
  // también aportara `action=opened`) no deberían dejar dos ramas OR
  // idénticas.
  const seen = new Set<string>()
  return groups.filter((g) => {
    const key = JSON.stringify(g)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** El array serializado que el motor va a re-agrupar de vuelta igual —
 *  `logic: 'or'` SÓLO en el primer elemento de cada grupo después del
 *  primero, sin arrastrar el `logic` que los elementos pudieran haber tenido
 *  antes de agruparlos (la agrupación en sí ya captura esa información). */
function serializeGroups(groups: readonly RawCond[][]): RawCond[] {
  const out: RawCond[] = []
  groups.forEach((group, gi) => {
    group.forEach((cond, ci) => {
      const { logic: _drop, ...rest } = cond
      out.push(gi > 0 && ci === 0 ? { ...rest, logic: 'or' } : rest)
    })
  })
  return out
}

/** El nuevo `on`: cada tipo curado se traduce a su(s) nombre(s) crudo(s); lo
 *  que no es curado se conserva tal cual. */
function translatedOnTypes(types: readonly string[]): string[] {
  const newOn = new Set<string>()
  for (const t of types) {
    const mapping = mappingFor(t)
    if (!mapping) {
      newOn.add(t) // no-GitHub o ya crudo: se conserva tal cual
      continue
    }
    if (mapping.kind === 'simple') for (const raw of mapping.rawTypes) newOn.add(raw)
    else newOn.add('pull_request')
  }
  return [...newOn]
}

export type LegacyRenamePlan =
  | { onTypes: string[]; when: RawCond[] }
  | { skip: true; reason: string }

/**
 * Traduce el `on`/`when` de UNA regla (o espera) de la taxonomía vieja a
 * nombres crudos. `null` = no usa la taxonomía vieja, no hay nada que hacer.
 *
 * `existingWhen` recibe el `when` YA PARSEADO (array u objeto, como lo
 * entrega `RuleSchema`/`JSON.parse`) — este módulo no sabe de dónde vino
 * (SQLite en JSON, o un YAML ya parseado por el loader), sólo de la forma.
 */
export function planLegacyRename(
  types: readonly string[],
  existingWhen: unknown,
): LegacyRenamePlan | null {
  if (!usesLegacyTaxonomy(types)) return null

  if (!canAutoTranslate(types)) {
    return {
      skip: true,
      reason:
        'mezcla tipos curados con requisitos de action distintos, o un tipo no curado — ' +
        'el when no puede distinguir de qué tipo vino el evento, necesita revisión MANUAL',
    }
  }

  if (existingWhen != null && !Array.isArray(existingWhen)) {
    return { skip: true, reason: 'when en formato Record — necesita migración MANUAL' }
  }

  const newOn = translatedOnTypes(types)
  const existingGroups = groupWhenArray((existingWhen as RawCond[] | null) ?? [])
  const required = requirementGroups(types)
  const finalGroups = existingGroups.length
    ? existingGroups.flatMap((eg) => required.map((rg) => [...eg, ...rg]))
    : required

  return { onTypes: newOn, when: serializeGroups(finalGroups) }
}
