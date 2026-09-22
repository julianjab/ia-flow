import { groupWhenArray } from '@ia-flow/rules'
import { createLogger } from '../logger.js'
import type { Migration } from './runner.js'

// El traductor de GitHub dejó de inventar nombres de evento (`pr.opened`,
// `ci.finished`, `issues.<action>`, …) — ver apps/server/src/adapters/github/
// webhook-events.ts. `EngineEvent.type` para un webhook de GitHub es ahora
// EXACTAMENTE el nombre crudo (`pull_request`, `check_suite`, `issues`, …), y
// `action` se filtra con `when`. Esta migración transforma las reglas Y LAS
// ESPERAS (`waits` — mismas columnas `on_types`/`when_conditions`, ver
// migración 060) que YA ESTÁN GUARDADAS, para que sigan disparando.
//
// Es transformación de datos que YA existen, no seed de config nueva —
// permitido por la regla de migraciones del CLAUDE.md raíz.
//
// **Cross-product, no concatenar.** Agregar la condición de `action` pegándola
// al final del `when` existente romper​ía cualquier fila con más de un grupo
// OR (el nuevo grupo quedaría sin las condiciones previas) o cualquier tipo
// curado con más de una `action` posible (`pr.opened` → opened/reopened: la
// rama `reopened` quedaría sin las condiciones existentes). Ver
// `groupWhenArray` (`@ia-flow/rules`) — mismo algoritmo de agrupación OR/AND
// que usa el evaluador, para no poder divergir de cómo el motor va a leer el
// resultado.
//
// **`pr.merged`/`pr.closed` sí son expresables** (a diferencia del intento
// anterior de esta migración): `pr.merged` → `pull_request` con
// `[action=closed, pr.merged=true]`; `pr.closed` → `[action=closed,
// pr.merged=false]`; si una regla tiene LOS DOS, se colapsan en
// `[action=closed]` sola (juntos cubren todo `closed`, sin necesidad del
// flag).
//
// Lo único que sigue sin auto-migrarse: `when_conditions` en formato Record
// legacy (`{additions: '$gt:500'}`) — convertirlo exige el parser de
// `$op:valor` de `packages/rules/src/when.ts`, no expuesto, y es un caso que
// hoy no se vio en ninguna regla real. Se saltea y se loguea para revisión
// manual.

const log = createLogger('migration:080')

interface RawCond {
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
 *  manda, así que la migración es directa: el prefijo es el tipo crudo. */
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

interface Row {
  id: string
  on_types: string
  when_conditions: string | null
}

type Plan = { onTypes: string[]; when: RawCond[] } | { skip: true; reason: string }
type ParsedTypes = { types: string[] } | { skip: true; reason: string }
type ParsedWhen = { when: RawCond[] } | { skip: true; reason: string }

/** `on_types` ya parseado y validado como array de strings — o el motivo por
 *  el que no se puede seguir. */
function parseOnTypes(raw: string): ParsedTypes {
  let onTypes: unknown
  try {
    onTypes = JSON.parse(raw)
  } catch {
    return { skip: true, reason: 'on_types no parsea como JSON' }
  }
  if (!Array.isArray(onTypes) || !onTypes.every((t) => typeof t === 'string')) {
    return { skip: true, reason: 'on_types no es un array de strings' }
  }
  return { types: onTypes as string[] }
}

/** `when_conditions` ya parseado a grupos OR/AND — o el motivo por el que no
 *  se puede seguir (JSON roto, o formato Record legacy). */
function parseExistingWhen(raw: string | null): ParsedWhen {
  let existingWhen: unknown = null
  try {
    existingWhen = raw ? JSON.parse(raw) : null
  } catch {
    return { skip: true, reason: 'when_conditions no parsea como JSON' }
  }
  if (existingWhen !== null && !Array.isArray(existingWhen)) {
    return { skip: true, reason: 'when_conditions en formato Record — necesita migración MANUAL' }
  }
  return { when: (existingWhen as RawCond[] | null) ?? [] }
}

/** El nuevo `on_types`: cada tipo curado se traduce a su(s) nombre(s)
 *  crudo(s); lo que no es curado se conserva tal cual. */
function migratedOnTypes(types: readonly string[]): string[] {
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

/** Pura: decide qué hacer con UNA fila (de `rules` o de `waits`, mismas
 *  columnas). `null` = esta fila no usa la taxonomía vieja, no se toca. */
export function planRowUpdate(row: Row): Plan | null {
  const parsedTypes = parseOnTypes(row.on_types)
  if ('skip' in parsedTypes) return parsedTypes
  const { types } = parsedTypes

  if (!types.some((t) => mappingFor(t) !== null)) return null // taxonomía vieja ausente

  const parsedWhen = parseExistingWhen(row.when_conditions)
  if ('skip' in parsedWhen) return parsedWhen

  const newOn = migratedOnTypes(types)
  const existingGroups = groupWhenArray(parsedWhen.when)
  const required = requirementGroups(types)
  const finalGroups = existingGroups.length
    ? existingGroups.flatMap((eg) => required.map((rg) => [...eg, ...rg]))
    : required

  return { onTypes: [...newOn], when: serializeGroups(finalGroups) }
}

function migrateTable(db: Parameters<Migration['up']>[0], table: 'rules' | 'waits') {
  const rows = db.query(`SELECT id, on_types, when_conditions FROM ${table}`).all() as Row[]
  const update = db.prepare(`UPDATE ${table} SET on_types = ?, when_conditions = ? WHERE id = ?`)
  let migrated = 0
  let skipped = 0

  for (const row of rows) {
    const plan = planRowUpdate(row)
    if (plan === null) continue
    if ('skip' in plan) {
      log.warn(
        { table, id: row.id, on: row.on_types, reason: plan.reason },
        'se saltea — revisar a mano',
      )
      skipped++
      continue
    }
    update.run(JSON.stringify(plan.onTypes), JSON.stringify(plan.when), row.id)
    log.info({ table, id: row.id, after: plan.onTypes, when: plan.when }, 'fila migrada')
    migrated++
  }

  log.info({ table, migrated, skipped }, 'migración de nombres de evento de GitHub terminada')
}

const migration: Migration = {
  id: '080-raw-github-event-types',
  description:
    'Migra rules.on_types/when_conditions y waits.on_types/when_conditions de la taxonomía curada de GitHub a nombres crudos',
  up(db) {
    migrateTable(db, 'rules')
    migrateTable(db, 'waits')
  },
}

export default migration
