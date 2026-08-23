import type { Migration } from './runner.js'

// AgentDefinition.maxConcurrentDispatches (packages/shared/src/schemas.ts) —
// tope de runs simultáneos de un agente, contado sobre el registry de pending
// tasks (ver capacity.ts en @ia-flow/agent-engine). NULL = sin límite propio;
// sólo aplican el cap del proyecto (project.settings) y el del provider
// (ProviderConfig.providerLimits), que viven en blobs JSON y por eso no
// necesitan columna.
//
// Sin esta columna el valor que mande la UI se perdería en silencio en cada
// `upsert` de SqliteAgentRepository — no tendría dónde persistirlo.
const migration: Migration = {
  id: '047-agent-max-concurrent-dispatches',
  description: 'Add max_concurrent_dispatches to agents (per-agent concurrency cap)',
  up(db) {
    const cols = db.query('PRAGMA table_info(agents)').all() as Array<{ name: string }>
    if (!cols.some((c) => c.name === 'max_concurrent_dispatches')) {
      db.run('ALTER TABLE agents ADD COLUMN max_concurrent_dispatches INTEGER')
    }
  },
}

export default migration
