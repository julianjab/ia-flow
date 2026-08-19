import type { Migration } from './runner.js'

// The blocker gate (dispatcher skips an issue whose source-native
// dependencies are still open) moves from StatusConfig to AgentDefinition —
// see AgentActivationSchema.allowBlocked in @ia-flow/shared. It's checked
// against the agent that's actually about to run (TaskDispatcher.dispatch,
// via selectAgent), not a separate `statuses` row looked up by name — that
// separate lookup is what this migration (and the TaskDispatcher change
// that shipped alongside it) removes from the dispatch hot path. `statuses`
// stays around as UI-only config (routes/statuses.ts) — this migration does
// not touch that table or drop `allow_blocked` from it, only stops the
// engine from reading it.
//
// Backfill: for each agent row with a `status_name`, copy `allow_blocked`
// from the `statuses` row with the same `(project_id, name)` — that's the
// exact row the old dispatch-time lookup would have matched. Global agents
// (`project_id IS NULL`) have no unambiguous `statuses` row to pick from
// (`statuses` is always scoped to one project) — they're left at the
// column default (0/false), same effective behavior as before (an
// unmatched status lookup also meant "blocked issues are skipped").
const migration: Migration = {
  id: '038-agent-allow-blocked',
  description:
    'Add allow_blocked to agents (blocker gate moves from StatusConfig to the matched agent) and backfill from statuses',
  up(db) {
    const cols = db.query('PRAGMA table_info(agents)').all() as Array<{ name: string }>
    if (!cols.some((c) => c.name === 'allow_blocked')) {
      db.run('ALTER TABLE agents ADD COLUMN allow_blocked INTEGER NOT NULL DEFAULT 0')
    }

    db.run(`
      UPDATE agents
      SET allow_blocked = (
        SELECT s.allow_blocked FROM statuses s
        WHERE s.project_id = agents.project_id
          AND lower(s.name) = lower(agents.status_name)
      )
      WHERE agents.project_id IS NOT NULL
        AND agents.status_name IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM statuses s
          WHERE s.project_id = agents.project_id
            AND lower(s.name) = lower(agents.status_name)
        )
    `)
  },
}

export default migration
