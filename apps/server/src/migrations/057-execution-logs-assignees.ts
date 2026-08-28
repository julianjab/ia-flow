import type { Migration } from './runner.js'

// Los assignees del issue, sobre la fila de la ejecución.
//
// Sin esto no hay forma de contestar "¿cómo le fue a los issues de fulano?":
// el dato existe en la tarea (`Task.assignees`, que ya viaja al provider para
// que un gateway personal decida su admisión) pero se perdía al escribir la
// fila, y `execution_logs` es la única tabla que sobrevive al run.
//
// JSON, no una columna por assignee ni una tabla aparte: un issue puede tener
// varios, `exits` ya establece el precedente de columna JSON en esta tabla, y
// el filtro se resuelve con `json_each` sin un join (ver
// SqliteExecutionLogRepository.list). Una tabla normalizada sería más prolija
// en SQL y mucho más maquinaria para lo que es un filtro de listado.
//
// Nullable y sin backfill: las filas previas a esta migración no tienen de
// dónde sacar el dato — el issue pudo cambiar de assignee desde entonces, así
// que inventarlo sería peor que dejarlo vacío. `null` = "no se registró", no
// "sin asignar".
//
// Idempotente, con el `hasColumn` correcto que la 053 documenta: bun:sqlite
// devuelve null (no undefined) cuando no hay fila.
const migration: Migration = {
  id: '057-execution-logs-assignees',
  description: 'Add execution_logs.assignees (JSON) for per-user traces',
  up(db) {
    const columns = db
      .query(`SELECT name FROM pragma_table_info('execution_logs')`)
      .all() as Array<{ name: string }>
    if (!columns.some((c) => c.name === 'assignees')) {
      db.run(`ALTER TABLE execution_logs ADD COLUMN assignees TEXT`)
    }
  },
}

export default migration
