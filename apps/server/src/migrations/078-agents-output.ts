import type { Migration } from './runner.js'

// AgentDefinition.output (packages/shared/src/schemas.ts) — el contrato de
// salida estructurada de un agente (`campo → forma`), que vuelve obligatorio
// llamar a `submit_output` antes de cerrar. Ya vivía en el schema Zod, pero
// SqliteAgentRepository no lo serializaba: un agente creado/editado vía
// UI/API lo perdía en el primer guardado. JSON blob, mismo patrón que
// `exits`/`verify`. NULL = sin contrato (sin cambio de comportamiento).
const migration: Migration = {
  id: '078-agents-output',
  description: 'Add output to agents (structured output contract)',
  up(db) {
    const cols = db.query('PRAGMA table_info(agents)').all() as Array<{ name: string }>
    if (!cols.some((c) => c.name === 'output')) {
      db.run('ALTER TABLE agents ADD COLUMN output TEXT')
    }
  },
}

export default migration
