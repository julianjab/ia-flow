import type { Migration } from './runner.js'

// La señal que le faltaba a `execution_logs`: no cómo terminó el run, sino si
// lo que produjo sirvió. Se puebla asíncronamente desde los eventos de PR
// (`pr.merged` / `pr.closed` / `pr.review_submitted`, ver
// `adapters/github/pr-outcome-handler.ts`) — llegan horas o días después del
// run, así que no puede resolverse en el `finally` del orquestador.
//
// Idempotente con el `hasColumn` que documenta la 053.
const COLUMNS: Array<[name: string, ddl: string]> = [
  // El PR al que se atribuyó este run — el que abrió, vía el branch del PR
  // (`task/<taskId>`, la convención de `packages/workspace/src/layout.ts`).
  ['pr_number', 'ALTER TABLE execution_logs ADD COLUMN pr_number INTEGER'],
  // `null` = todavía no se sabe (sin PR, o PR abierto sin resolver). `1`/`0`
  // (SQLite no tiene boolean) = mergeado / cerrado sin merge.
  ['pr_merged', 'ALTER TABLE execution_logs ADD COLUMN pr_merged INTEGER'],
  // Cuántas `pr.review_submitted` recibió el PR atribuido a este run.
  ['review_rounds', 'ALTER TABLE execution_logs ADD COLUMN review_rounds INTEGER'],
]

const migration: Migration = {
  id: '073-execution-logs-pr-outcome',
  description: 'execution_logs: pr_number, pr_merged, review_rounds',
  up(db) {
    const columns = db
      .query(`SELECT name FROM pragma_table_info('execution_logs')`)
      .all() as Array<{ name: string }>
    const existing = new Set(columns.map((c) => c.name))
    for (const [name, ddl] of COLUMNS) {
      if (!existing.has(name)) db.run(ddl)
    }
  },
}

export default migration
