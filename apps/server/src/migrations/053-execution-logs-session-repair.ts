import type { Migration } from './runner.js'

// Repara las DBs donde `session_kind` / `session_id` nunca llegaron a existir.
//
// Mismo accidente que arregló la 049, con otra causa: el `hasColumn` de la 023
// comparaba el resultado de `.get()` contra `undefined`, y bun:sqlite devuelve
// **null** cuando no hay fila. Así que el chequeo daba `true` para cualquier
// columna, los dos ALTER nunca corrieron, y la 023 igual quedó registrada en
// `schema_migrations` — el runner no la vuelve a ejecutar aunque hoy su
// `hasColumn` esté arreglado.
//
// El síntoma es el mismo que documenta la 049: `SqliteExecutionLogRepository`
// escribe `session_kind`/`session_id` en cada insert, así que TODO insert
// explota con "table execution_logs has no column named session_kind".
// `safeInsertLog` traga el error a propósito (un fallo de telemetría no debe
// voltear un run), de modo que los agentes trabajan normal pero la tabla queda
// vacía — y la UI, que lee `finished_at IS NULL`, muestra cero ejecuciones en
// proceso mientras hay runs vivos. Afecta a toda DB creada de cero después de
// que la 023 entró: el flavor `runner` de un deploy nuevo es el caso típico.
//
// Idempotente: en una DB sana no hace nada.
const migration: Migration = {
  id: '053-execution-logs-session-repair',
  description: 'Backfill session_kind/session_id skipped by a no-op 023',
  up(db) {
    const columns = db
      .query(`SELECT name FROM pragma_table_info('execution_logs')`)
      .all() as Array<{ name: string }>
    const has = (name: string) => columns.some((c) => c.name === name)
    if (!has('session_kind')) db.run(`ALTER TABLE execution_logs ADD COLUMN session_kind TEXT`)
    if (!has('session_id')) db.run(`ALTER TABLE execution_logs ADD COLUMN session_id TEXT`)
  },
}

export default migration
