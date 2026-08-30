import type { Migration } from './runner.js'

// Una ejecución deja de ser "un run de agente" y pasa a ser "algo que el
// pipeline corrió".
//
// El agujero que cierra: cuando una regla dispara, corre su `do[]` en orden y
// una de esas acciones puede ser un agente. De esa cadena, lo único que
// quedaba escrito era el run del agente — y ni siquiera sabía qué regla lo
// había disparado. La notificación que corrió un segundo antes existía sólo en
// una línea de log que rota, y `parentRunId` (el sub-agente de `run_agent`)
// vivía únicamente en el registry en memoria: un reinicio le borraba el padre
// a un hijo que seguía corriendo.
//
// **Por qué acá y no en `action_runs`.** Esa tabla (migración 058) modela bien
// una acción, pero deja al operador con dos listados que hay que unir por
// timestamp para contestar una sola pregunta. Se da de baja acá: su
// `ActionRunRecorder` nunca se cableó, así que **está vacía** y no hay dato que
// migrar. Un `DROP` de una tabla con filas sería otra conversación.
//
// **Por qué no una tabla padre.** `(event_id, rule_id)` YA identifica un
// disparo de regla — el evento es único por definición del bus. Una fila padre
// no agregaría información, sólo un ciclo de vida más que mantener.
//
// Las columnas NOT NULL de siempre (`agent_id`, `provider_id`, `task_id`,
// `task_title`) se quedan como están: una fila que no es de agente escribe `''`
// ahí. Sacarles el NOT NULL obliga a SQLite a reconstruir la tabla entera —30+
// columnas, con datos vivos y con índices— y eso es más riesgo que un centinela
// documentado en el schema.
//
// Idempotente con el `hasColumn` que documenta la 053: bun:sqlite devuelve null
// (no undefined) cuando no hay fila.
const COLUMNS: Array<[name: string, ddl: string]> = [
  // El default hace el backfill solo: todo lo que había antes de esta
  // migración era, efectivamente, un run de agente.
  ['kind', `ALTER TABLE execution_logs ADD COLUMN kind TEXT NOT NULL DEFAULT 'agent'`],
  ['rule_id', `ALTER TABLE execution_logs ADD COLUMN rule_id TEXT`],
  ['event_id', `ALTER TABLE execution_logs ADD COLUMN event_id TEXT`],
  ['event_type', `ALTER TABLE execution_logs ADD COLUMN event_type TEXT`],
  ['position', `ALTER TABLE execution_logs ADD COLUMN position INTEGER`],
  ['parent_id', `ALTER TABLE execution_logs ADD COLUMN parent_id TEXT`],
]

const migration: Migration = {
  id: '065-executions-pipeline',
  description: 'execution_logs: kind + causa (rule/event/position) + parent_id; baja action_runs',
  up(db) {
    const columns = db
      .query(`SELECT name FROM pragma_table_info('execution_logs')`)
      .all() as Array<{ name: string }>
    const existing = new Set(columns.map((c) => c.name))
    for (const [name, ddl] of COLUMNS) {
      if (!existing.has(name)) db.run(ddl)
    }

    // El índice es por el listado agrupado: la pantalla pide las filas de un
    // disparo (`event_id`) y las de un hijo (`parent_id`), y sin índice son dos
    // scans completos de la tabla más grande de la base.
    db.run(`CREATE INDEX IF NOT EXISTS idx_execution_logs_event ON execution_logs(event_id)`)
    db.run(`CREATE INDEX IF NOT EXISTS idx_execution_logs_parent ON execution_logs(parent_id)`)

    // Ver arriba: nunca se escribió, así que esto no pierde nada.
    db.run(`DROP TABLE IF EXISTS action_runs`)
  },
}

export default migration
