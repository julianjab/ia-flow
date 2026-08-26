import type { Migration } from './runner.js'

// Repara las DBs donde `finalized_by_tool` nunca llegó a existir.
//
// La 048 agrega esa columna junto con `initial_status` / `on_finish` /
// `on_error`, y su `up` es idempotente (consulta `pragma_table_info` antes de
// cada ALTER). Pero el id de una migración se registra una sola vez: una DB
// que corrió la 048 mientras la columna todavía no formaba parte de su
// `COLUMNS` quedó con las tres primeras y sin la cuarta, y el runner no la
// vuelve a ejecutar nunca porque `048-...` ya figura en `schema_migrations`.
//
// El síntoma no es sutil: `SqliteExecutionLogRepository.insert` escribe esa
// columna, así que TODO insert explota con "table execution_logs has no column
// named finalized_by_tool". `safeInsertLog` traga el error (a propósito: un
// fallo de telemetría no debe voltear un run), de modo que los agentes siguen
// corriendo pero ninguna fila se crea — y la UI, que lee `finished_at IS NULL`
// de esta tabla, muestra cero ejecuciones en proceso mientras hay runs vivos.
//
// Idempotente por la misma razón que la 048: en una DB sana no hace nada.
const migration: Migration = {
  id: '049-execution-logs-finalized-by-tool',
  description: 'Backfill the finalized_by_tool column skipped by a partially-applied 048',
  up(db) {
    const columns = db
      .query(`SELECT name FROM pragma_table_info('execution_logs')`)
      .all() as Array<{
      name: string
    }>
    if (columns.some((c) => c.name === 'finalized_by_tool')) return
    db.run(`ALTER TABLE execution_logs ADD COLUMN finalized_by_tool INTEGER`)
  },
}

export default migration
