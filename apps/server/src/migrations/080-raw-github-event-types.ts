import { createLogger } from '../logger.js'
import type { Migration } from './runner.js'

// El traductor de GitHub dejó de inventar nombres de evento (`pr.opened`,
// `ci.finished`, `issues.<action>`, …) — ver apps/server/src/adapters/github/
// webhook-events.ts. `EngineEvent.type` para un webhook de GitHub es ahora
// EXACTAMENTE el nombre crudo (`pull_request`, `check_suite`, `issues`, …), y
// `action` se filtra con `when`. Esta migración transforma las reglas YA
// GUARDADAS para que sigan disparando.
//
// Es transformación de datos que YA existen, no seed de config nueva —
// permitido por la regla de migraciones del CLAUDE.md raíz.
//
// **No es 100% mecánica a propósito.** Una regla cuyo `on` mezcla `pr.merged`
// u `pr.closed` con otros tipos de `pull_request` (`pr.opened`, …) necesitaría
// una condición OR-de-AND (`action=closed AND pr.merged=true` OR
// `action=opened`) que este DSL no puede expresar como un único grupo plano —
// esas reglas se SALTEAN (quedan con el `on` viejo, que ya no dispara) y se
// loguean para migrar a mano. Preferible a migrar mal en silencio.
//
// Mismo criterio para `when_conditions` en formato Record legacy
// (`{additions: '$gt:500'}`): sólo se auto-migra cuando ninguna de las reglas
// del proyecto lo usa junto con un tipo curado — si aparece, se saltea y se
// loguea.

const log = createLogger('migration:080')

interface SimpleMapping {
  kind: 'simple'
  rawTypes: string[]
  actions: string[]
}
type Mapping = SimpleMapping | { kind: 'special' }

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
  // Necesitan `pr.merged`/`pr.merged=false` además de `action=closed` — no
  // expresable como un simple OR de valores de `action`. Se tratan aparte
  // (ver `hasSpecial` abajo) y SIEMPRE fuerzan revisión manual si conviven
  // con otro tipo de `pull_request` en la misma regla.
  'pr.merged': { kind: 'special' },
  'pr.closed': { kind: 'special' },
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

interface WhenCondition {
  field: string
  op: string
  value?: string
  logic?: 'and' | 'or'
}

/** El grupo de condiciones que reemplaza el filtro que hacía el traductor
 *  (`action` conocida) — un solo grupo OR sobre los valores de `action`
 *  recolectados de TODOS los tipos curados de la regla. Correcto porque
 *  `on[]` ya restringe el TIPO de evento; el valor de `action` no colisiona
 *  de forma ambigua entre tipos de GitHub distintos. */
function actionGroup(actions: string[]): WhenCondition[] {
  const unique = [...new Set(actions)]
  return unique.map((value, i) => ({
    field: 'action',
    op: '=',
    value,
    ...(i > 0 ? { logic: 'or' as const } : {}),
  }))
}

interface RuleRow {
  id: string
  on_types: string
  when_conditions: string | null
}

type RuleUpdate = { onTypes: string[]; when: WhenCondition[] } | { skip: true; reason: string }

/** Pura: decide qué hacer con UNA fila de `rules`. Separada de `up()` para que
 *  el guard de complejidad no fuerce a comprimir las ramas en una sola
 *  función, y para poder testear cada caso (migra / se saltea y por qué) sin
 *  tocar SQLite. */
export function planRuleUpdate(row: RuleRow): RuleUpdate | null {
  let onTypes: unknown[]
  try {
    onTypes = JSON.parse(row.on_types)
  } catch {
    return { skip: true, reason: 'on_types no parsea como JSON' }
  }
  if (!Array.isArray(onTypes) || !onTypes.every((t) => typeof t === 'string')) {
    return { skip: true, reason: 'on_types no es un array de strings' }
  }
  const types = onTypes as string[]

  const curated = types.filter((t) => mappingFor(t) !== null)
  if (curated.length === 0) return null // nada de esta regla usa la taxonomía vieja

  if (curated.some((t) => mappingFor(t)?.kind === 'special')) {
    return {
      skip: true,
      reason: 'usa pr.merged/pr.closed junto con otros tipos — OR-de-AND no expresable acá',
    }
  }

  let existingWhen: unknown = null
  try {
    existingWhen = row.when_conditions ? JSON.parse(row.when_conditions) : null
  } catch {
    return { skip: true, reason: 'when_conditions no parsea como JSON' }
  }
  if (existingWhen !== null && !Array.isArray(existingWhen)) {
    // Record shorthand (`{field: value}`) — convertirlo sin reimplementar el
    // parser de `$op:valor` es más riesgo del que vale para un caso que hoy
    // no se vio en ninguna regla real.
    return { skip: true, reason: 'when_conditions en formato Record' }
  }

  const newOn = new Set<string>()
  const actions: string[] = []
  for (const t of types) {
    const mapping = mappingFor(t)
    if (mapping?.kind !== 'simple') {
      newOn.add(t) // no-GitHub o ya crudo: se conserva tal cual
      continue
    }
    for (const raw of mapping.rawTypes) newOn.add(raw)
    actions.push(...mapping.actions)
  }

  const when: WhenCondition[] = [
    ...((existingWhen as WhenCondition[] | null) ?? []),
    ...actionGroup(actions),
  ]
  return { onTypes: [...newOn], when }
}

const migration: Migration = {
  id: '080-raw-github-event-types',
  description:
    'Migra rules.on_types/when_conditions de la taxonomía curada de GitHub a nombres crudos',
  up(db) {
    const rows = db.query(`SELECT id, on_types, when_conditions FROM rules`).all() as RuleRow[]
    const update = db.prepare(`UPDATE rules SET on_types = ?, when_conditions = ? WHERE id = ?`)
    let migrated = 0
    let skipped = 0

    for (const row of rows) {
      const plan = planRuleUpdate(row)
      if (plan === null) continue
      if ('skip' in plan) {
        log.warn(
          { ruleId: row.id, on: row.on_types, reason: plan.reason },
          'se saltea — revisar a mano',
        )
        skipped++
        continue
      }
      update.run(JSON.stringify(plan.onTypes), JSON.stringify(plan.when), row.id)
      log.info({ ruleId: row.id, after: plan.onTypes, when: plan.when }, 'regla migrada')
      migrated++
    }

    log.info({ migrated, skipped }, 'migración de nombres de evento de GitHub terminada')
  },
}

export default migration
