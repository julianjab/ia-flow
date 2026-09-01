import type { Migration } from './runner.js'

// Lo que le faltaba a la telemetría de la 045 para contestar "cuánto cuesta
// este agente y por qué".
//
// - `model`: sin él los tokens no tienen precio. El panel de salud sumaba
//   entrada fresca por agente, pero 3M en Haiku y 3M en Opus difieren 5x y la
//   tabla los ordenaba igual. El costo NO se persiste: se deriva al leer con la
//   tabla de precios de `@ia-flow/shared`, así un cambio de tarifa no obliga a
//   reescribir filas.
// - `system_prompt_hash`: `agent_prompt_hash` ya cubre los system prompts, pero
//   mezclados con el resto de la config. Cuando cambia no dice si se editó el
//   agente o un system prompt compartido por todo el roster; con los dos
//   hashes se cruza.
// - `tool_breakdown`: JSON `{ tool: { calls, errors } }`. Una entrada por tool
//   y no por llamada, así que es chico por construcción y cabe en la fila —
//   a diferencia del checkpoint de la 066, que sí necesitó tabla aparte.
//
// Idempotente con el `hasColumn` que documenta la 053. Sin backfill: un run
// viejo sin modelo cuenta como "costo desconocido" (null), que es lo que fue.
const COLUMNS: Array<[name: string, ddl: string]> = [
  ['model', 'ALTER TABLE execution_logs ADD COLUMN model TEXT'],
  ['system_prompt_hash', 'ALTER TABLE execution_logs ADD COLUMN system_prompt_hash TEXT'],
  ['tool_breakdown', 'ALTER TABLE execution_logs ADD COLUMN tool_breakdown TEXT'],
]

const migration: Migration = {
  id: '067-execution-logs-cost',
  description: 'execution_logs: model + system_prompt_hash + tool_breakdown',
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
