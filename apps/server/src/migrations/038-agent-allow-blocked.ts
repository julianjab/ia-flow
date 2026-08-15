import type { Migration } from './runner.js'

// The blocker gate (dispatcher skips an issue whose source-native
// dependencies are still open) moves from StatusConfig to AgentDefinition —
// see AgentActivationSchema.allowBlocked in @ia-flow/shared. It's checked
// against the agent that's actually about to run (TaskDispatcher.dispatch,
// via selectAgent), not a separate `statuses` row looked up by name — that
// separate lookup is what this migration (and the TaskDispatcher change
// that shipped alongside it) removes from the dispatch-gate hot path.
// `statuses` stays around unchanged — still read for the UI
// (routes/statuses.ts) and for SourceIssueManager's scan-cycle prefilter
// (which status NAMES are worth fetching at all; the prefilter never looked
// at `allow_blocked`, only `name`). `statuses.allow_blocked` itself becomes
// dead going forward (see the deprecation note on StatusConfigSchema in
// @ia-flow/shared) — this migration reads it once, for the backfill below,
// and nothing writes it anymore after this.
//
// Backfill has three cases, because the old lookup was keyed by
// `item.status` + the DISPATCHING project (not the matched agent's own
// `project_id`) — a subtlety that matters once agents can be global:
//
//   1. Project-scoped agent with a `status_name` — exact case: copy
//      `allow_blocked` from the `statuses` row with that same
//      `(project_id, name)`, the precise row the old lookup matched.
//      `MAX(...)` resolves the (unlikely) case of two differently-cased
//      duplicate status names in the same project deterministically instead
//      of leaving it to SQLite's arbitrary row pick on a bare correlated
//      subquery — and doubles as "prefer allowed" if they disagree.
//   2. GLOBAL agent (`project_id IS NULL`) with a `status_name` — this
//      agent could dispatch against an item from ANY project, and the old
//      gate would key off THAT project's status row, not a fixed one. A
//      single static column can't hold "it depends which project" — bias
//      toward NOT introducing a silent new skip: set 1 if any project's
//      status row with that name has `allow_blocked = 1` anywhere.
//   3. Agent with `status_name IS NULL` (matches every status, project-
//      scoped or global) — genuinely underdetermined: the old gate's value
//      varied per dispatch depending on which status the item actually sat
//      in. There is no single correct backfill here. Left at the column
//      default (0/false) — if such an agent relied on `allowBlocked: true`
//      for some statuses, review it manually after this migration runs.
const migration: Migration = {
  id: '038-agent-allow-blocked',
  description:
    'Add allow_blocked to agents (blocker gate moves from StatusConfig to the matched agent) and backfill from statuses',
  up(db) {
    const cols = db.query('PRAGMA table_info(agents)').all() as Array<{ name: string }>
    if (!cols.some((c) => c.name === 'allow_blocked')) {
      db.run('ALTER TABLE agents ADD COLUMN allow_blocked INTEGER NOT NULL DEFAULT 0')
    }

    // Case 1 — project-scoped agent, exact (project_id, name) match.
    db.run(`
      UPDATE agents
      SET allow_blocked = (
        SELECT COALESCE(MAX(s.allow_blocked), 0) FROM statuses s
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

    // Case 2 — global agent, no fixed project to scope the join to: match
    // any project's status row with that name, biased toward "allowed".
    db.run(`
      UPDATE agents
      SET allow_blocked = 1
      WHERE agents.project_id IS NULL
        AND agents.status_name IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM statuses s
          WHERE lower(s.name) = lower(agents.status_name)
            AND s.allow_blocked = 1
        )
    `)

    // Case 3 — can't backfill (see comment above), but silently leaving an
    // agent that used to dispatch blocked issues at allow_blocked=0 is
    // exactly the kind of thing an operator needs to know happened. List
    // them so it shows up in the migration output instead of only in a
    // code comment nobody re-reads post-migration.
    const undecidable = db
      .query('SELECT id, project_id FROM agents WHERE status_name IS NULL')
      .all() as Array<{ id: string; project_id: string | null }>
    for (const row of undecidable) {
      console.log(
        `[038-agent-allow-blocked] agent "${row.id}" (project ${row.project_id ?? 'global'}) has no status_name — allow_blocked left at the default (false). Review manually if it used to dispatch blocked issues on some status.`,
      )
    }
  },
}

export default migration
