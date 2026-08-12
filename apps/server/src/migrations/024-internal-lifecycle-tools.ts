import type { Database } from 'bun:sqlite'
import type { Migration } from './runner.js'

// After marking `complete_task` and `fail_task` as internal tools (see
// apps/server/src/tools/task.ts + tools/index.ts), agents must no longer
// declare them in their `tools` allow-list — they're auto-injected. Strip
// them from every seeded agent so the allow-list only carries user-facing
// tools; the runtime contract (lifecycle hooks) is handled by the engine.
const LIFECYCLE_TOOLS = new Set(['complete_task', 'fail_task'])

const migration: Migration = {
  id: '024-internal-lifecycle-tools',
  description:
    'Marca complete_task/fail_task como tools internas: se remueven de agents.tools (siempre inyectadas por el engine).',
  up(db: Database): void {
    const rows = db.query('SELECT id, tools FROM agents WHERE tools IS NOT NULL').all() as {
      id: string
      tools: string | null
    }[]

    for (const row of rows) {
      if (!row.tools) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(row.tools)
      } catch {
        continue
      }
      if (!Array.isArray(parsed)) continue
      const before = parsed as string[]
      const after = before.filter((t) => !LIFECYCLE_TOOLS.has(t))
      if (after.length === before.length) continue

      // `[]` semantically means "no user-facing tools declared" — the engine
      // will still inject internals. Keep the array (rather than NULL) so the
      // agent's intent — "I opted in to zero extras" — is preserved.
      db.run(`UPDATE agents SET tools = ? WHERE id = ?`, [JSON.stringify(after), row.id])
    }
  },
}

export default migration
