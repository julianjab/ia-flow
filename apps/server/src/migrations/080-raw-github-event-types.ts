import { planLegacyRename, type RawCond } from '../adapters/github/legacy-event-rename.js'
import { createLogger } from '../logger.js'
import type { Migration } from './runner.js'

// Migra `rules.on_types`/`when_conditions` y `waits.on_types`/
// `when_conditions` (SQLite) de la taxonomía curada de GitHub a nombres
// crudos — ver `adapters/github/legacy-event-rename.ts` para el algoritmo
// (compartido con `YamlRuleRepository`, que hace lo mismo para las reglas de
// un deploy headless en `runner.yaml`, que esta migración NO alcanza).
//
// Es transformación de datos que YA existen, no seed de config nueva —
// permitido por la regla de migraciones del CLAUDE.md raíz.

const log = createLogger('migration:080')

interface Row {
  id: string
  on_types: string
  when_conditions: string | null
}

type Plan = { onTypes: string[]; when: RawCond[] } | { skip: true; reason: string }

/** Pura: decide qué hacer con UNA fila (de `rules` o de `waits`, mismas
 *  columnas). `null` = esta fila no usa la taxonomía vieja, no se toca. */
export function planRowUpdate(row: Row): Plan | null {
  let onTypes: unknown
  try {
    onTypes = JSON.parse(row.on_types)
  } catch {
    return { skip: true, reason: 'on_types no parsea como JSON' }
  }
  if (!Array.isArray(onTypes) || !onTypes.every((t) => typeof t === 'string')) {
    return { skip: true, reason: 'on_types no es un array de strings' }
  }

  let existingWhen: unknown = null
  try {
    existingWhen = row.when_conditions ? JSON.parse(row.when_conditions) : null
  } catch {
    return { skip: true, reason: 'when_conditions no parsea como JSON' }
  }

  return planLegacyRename(onTypes as string[], existingWhen)
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
