import type { Migration } from './runner.js'

// AgentDefinition.verify (packages/shared/src/schemas.ts) — comandos que el
// ENGINE corre en el worktree después del loop y antes de aplicar la salida
// de éxito de un run sync (ver runVerifyCommands en @ia-flow/agent-engine).
// JSON array, mismo patrón que `tools`/`exits`: NULL = sin verify (sin
// cambio de comportamiento).
const migration: Migration = {
  id: '072-agents-verify',
  description: 'Add verify to agents (post-run verification commands)',
  up(db) {
    const cols = db.query('PRAGMA table_info(agents)').all() as Array<{ name: string }>
    if (!cols.some((c) => c.name === 'verify')) {
      db.run('ALTER TABLE agents ADD COLUMN verify TEXT')
    }
  },
}

export default migration
