import type { Database } from 'bun:sqlite'
import type { Migration } from './runner.js'

// Historia: esta migración se renombró (era 022 en una rama previa) y
// algunas DBs locales quedaron con las columnas aplicadas pero sin la fila
// correspondiente en `schema_migrations` bajo el nuevo id. Chequeamos
// `pragma_table_info` antes del ALTER para que el runner pueda marcarla
// como aplicada sin explotar por "duplicate column name".
function hasColumn(db: Database, table: string, column: string): boolean {
  const row = db.query(`SELECT 1 FROM pragma_table_info(?) WHERE name = ?`).get(table, column) as
    | { 1: number }
    | undefined
  return row !== undefined
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
