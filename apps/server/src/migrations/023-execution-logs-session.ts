import type { Database } from 'bun:sqlite'
import type { Migration } from './runner.js'

// Historia: esta migración se renombró (era 022 en una rama previa) y
// algunas DBs locales quedaron con las columnas aplicadas pero sin la fila
// correspondiente en `schema_migrations` bajo el nuevo id. Chequeamos
// `pragma_table_info` antes del ALTER para que el runner pueda marcarla
// como aplicada sin explotar por "duplicate column name".
function hasColumn(db: Database, table: string, column: string): boolean {
  // `.all()` + `some`, y no `.get()` contra `undefined`: bun:sqlite devuelve
  // **null** —no undefined— cuando la consulta no matchea ninguna fila, así
  // que el `!== undefined` de la primera versión daba `true` para CUALQUIER
  // columna. En una DB nueva eso saltea los dos ALTER y deja la tabla sin
  // `session_kind`/`session_id` con la migración marcada como aplicada; como
  // `SqliteExecutionLogRepository.insert` escribe esas columnas, todo insert
  // explota y `safeInsertLog` se lo traga: los agentes corren y la tabla
  // queda vacía. La reparación de las DBs ya rotas es la 053 —esta corrección
  // sola no las alcanza, porque el id ya figura en `schema_migrations`.
  const rows = db.query(`SELECT name FROM pragma_table_info(?)`).all(table) as Array<{
    name: string
  }>
  return rows.some((r) => r.name === column)
}

const migration: Migration = {
  id: '023-execution-logs-session',
  description: 'Track backing OS session (kind + id) per execution for cancel + watchdog',
  up(db) {
    if (!hasColumn(db, 'execution_logs', 'session_kind')) {
      db.run(`ALTER TABLE execution_logs ADD COLUMN session_kind TEXT`)
    }
    if (!hasColumn(db, 'execution_logs', 'session_id')) {
      db.run(`ALTER TABLE execution_logs ADD COLUMN session_id   TEXT`)
    }
  },
}

export default migration
