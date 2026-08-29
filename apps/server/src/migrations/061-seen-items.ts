import type { Migration } from './runner.js'

// Crea `seen_items`: el estado del board tal como lo dejó el scan anterior.
//
// Es lo único que faltaba para que el scan pueda producir un HECHO
// (`issue.status_changed`) en vez de una observación (`issue.scanned`). Sin
// esto, cada tick reprocesa el board entero y una regla sólo puede condicionar
// sobre "está en Ready", nunca sobre "pasó a Ready".
//
// La PK es `(project_id, item_id)` y no un id sintético: un item pertenece a
// exactamente un proyecto, y la consulta siempre es "todo lo visto de este
// proyecto". Un id aparte necesitaría un índice único encima para garantizar lo
// mismo.
//
// No guarda el item entero, sólo el status: es lo único contra lo que se
// diffea, y persistir el resto haría que la tabla crezca con datos que ya viven
// en la fuente.

const migration: Migration = {
  id: '061-seen-items',
  description: 'Create seen_items — board state from the previous scan, for status diffing',
  up(db) {
    db.run(`
      CREATE TABLE IF NOT EXISTS seen_items (
        project_id TEXT NOT NULL,
        item_id    TEXT NOT NULL,
        status     TEXT NOT NULL,
        seen_at    TEXT NOT NULL,
        PRIMARY KEY (project_id, item_id)
      )
    `)
  },
}

export default migration
