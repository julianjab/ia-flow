import type { Migration } from './runner.js'

// Persiste lo que un agente entregó por `submit_output` (packages/tools/src/
// task/submit-output.ts) más allá de su propio run: hoy sólo vive en
// `PendingTask.structuredOutput`, en memoria, y se pierde en el salto al
// siguiente dispatch. Con esta columna sobrevive para que cualquier agente
// posterior sobre la misma task pueda leer la última salida de cada agente
// vía `{{task.previous_outputs}}` (ver apps/server/src/variables/task.ts).
//
// Nullable — la inmensa mayoría de los runs no declara salida estructurada —
// y JSON en texto: es chico (un puñado de campos por agente) y write-once al
// cierre del run (`buildFinishPatch`), lejos de la masa crítica que mandó los
// checkpoints a una tabla propia (ver migración 066).
//
// A propósito EXCLUIDA de la proyección de `list()` (SqliteExecutionLogRepository):
// ese listado es el `SELECT *` que powers `GET /api/executions`, y no hay
// motivo para que cada fila del listado arrastre JSON que sólo hace falta al
// leer una fila puntual (`getById`) o al hidratar `previous_outputs`.
const migration: Migration = {
  id: '071-execution-logs-structured-output',
  description: 'execution_logs: structured_output',
  up(db) {
    const columns = db
      .query(`SELECT name FROM pragma_table_info('execution_logs')`)
      .all() as Array<{ name: string }>
    const existing = new Set(columns.map((c) => c.name))
    if (!existing.has('structured_output')) {
      db.run('ALTER TABLE execution_logs ADD COLUMN structured_output TEXT')
    }
  },
}

export default migration
