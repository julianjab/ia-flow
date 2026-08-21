import type { Migration } from './runner.js'

// AgentActivationSchema.whenText (packages/shared/src/schemas.ts) — texto
// libre hermano de `when`, usado hoy por AgentProviderChoiceSchema.whenText
// para desambiguar entre providers candidatos vía Haiku (ver
// packages/agent-engine/src/provider-selection.ts). Se agrega también acá,
// al nivel del agente, con la misma forma — no lo consume `selectAgent`
// todavía, pero sin esta columna cualquier valor que la UI/API llegue a
// setear se perdería en silencio en cada `upsert` (SqliteAgentRepository no
// tendría dónde persistirlo).
//
// `agents.provider` (columna TEXT existente) no necesita ALTER: ya acepta
// cualquier string, y el array de candidatos ahora se persiste ahí como JSON
// — ver SqliteAgentRepository.upsert/rowToAgent.
const migration: Migration = {
  id: '041-agent-when-text',
  description: 'Add when_text to agents (free-text sibling of when, used for Haiku disambiguation)',
  up(db) {
    const cols = db.query('PRAGMA table_info(agents)').all() as Array<{ name: string }>
    if (!cols.some((c) => c.name === 'when_text')) {
      db.run('ALTER TABLE agents ADD COLUMN when_text TEXT')
    }
  },
}

export default migration
