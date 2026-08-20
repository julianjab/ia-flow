import type { Migration } from './runner.js'

// Las labels dejan de ser un canal de outcome propio y pasan a ser lo que
// siempre fueron conceptualmente: el campo multi-valor del source. Antes cada
// slot tenía dos columnas — `on_process` (con el DSL `$set:` contra campos) y
// `on_process_labels` (con el DSL `$labels:`, aplicado con una primitiva
// distinta, `setLabels`) — y la UI tenía que serializar UNA fila del editor
// ("field = Labels, value = +a,-b") en dos lugares distintos. Ahora hay un
// solo canal por slot: `$set:`, con `Labels` como un campo más y sus tokens
// con signo resueltos por el source (ver applyMultiValueOps en
// @ia-flow/issue-sources).
//
// La conversión es textual y directa:
//   on_finish_labels = '$labels:+a,-b'   →  fragmento 'Labels=+a,-b'
// que se ANEXA al `$set:` del mismo slot (o lo crea si el slot estaba vacío).
//
// El caso que obliga a mirar el `on_finish` existente en vez de escribir
// ciego: un slot podía tener AMBAS columnas (mover el status Y tocar labels).
// Tres formas posibles del valor viejo:
//   · vacío            → el slot pasa a ser sólo '$set:Labels=...'
//   · '$set:...'       → se concatena con coma al cuerpo existente
//   · 'NombreStatus'   → forma corta de status; se expande a
//                        '$set:status=NombreStatus,Labels=...' para no perder
//                        la transición al fusionar.
const SLOTS = [
  { field: 'on_process', labels: 'on_process_labels' },
  { field: 'on_finish', labels: 'on_finish_labels' },
  { field: 'on_error', labels: 'on_error_labels' },
] as const

const LABEL_PREFIX = '$labels:'
const SET_PREFIX = '$set:'

/** Devuelve el nuevo valor del slot, o null si no hay nada que convertir. */
export function mergeLabelsIntoSet(
  fieldValue: string | null,
  labelsValue: string | null,
): string | null {
  const spec = labelsValue?.startsWith(LABEL_PREFIX)
    ? labelsValue.slice(LABEL_PREFIX.length).trim()
    : (labelsValue?.trim() ?? '')
  if (!spec) return null

  const fragment = `Labels=${spec}`
  const current = fieldValue?.trim() ?? ''
  if (!current) return `${SET_PREFIX}${fragment}`
  if (current.startsWith(SET_PREFIX)) {
    const body = current.slice(SET_PREFIX.length).trim()
    return body ? `${SET_PREFIX}${body},${fragment}` : `${SET_PREFIX}${fragment}`
  }
  // Forma corta: el slot era un nombre de status pelado.
  return `${SET_PREFIX}status=${current},${fragment}`
}

const migration: Migration = {
  id: '039-outcomes-labels-into-fields',
  description:
    'Fold on_{process,finish,error}_labels into the $set: outcome of each slot as the multi-value field `Labels`, then drop the columns',
  up(db) {
    const cols = db.query('PRAGMA table_info(agents)').all() as Array<{ name: string }>
    const present = SLOTS.filter((s) => cols.some((c) => c.name === s.labels))
    if (!present.length) return

    const rows = db.query('SELECT * FROM agents').all() as Array<Record<string, unknown>>
    for (const row of rows) {
      for (const slot of present) {
        const merged = mergeLabelsIntoSet(
          (row[slot.field] as string | null) ?? null,
          (row[slot.labels] as string | null) ?? null,
        )
        if (merged === null) continue
        db.run(`UPDATE agents SET ${slot.field} = ? WHERE id = ?`, [merged, row.id as string])
        console.log(
          `[039-outcomes-labels-into-fields] agent "${row.id}": ${slot.labels} → ${slot.field} = ${merged}`,
        )
      }
    }

    // DROP COLUMN existe en SQLite desde 3.35 (bun:sqlite trae una muy
    // posterior). Se hace después del UPDATE de TODAS las filas, no por slot,
    // para que un fallo a mitad deje la migración entera revertida por la
    // transacción del runner en vez de datos convertidos a medias.
    for (const slot of present) {
      db.run(`ALTER TABLE agents DROP COLUMN ${slot.labels}`)
    }
  },
}

export default migration
