import type { Database } from 'bun:sqlite'
import type { Migration } from './runner.js'

// Sync local statuses table with real GitHub Project options:
//   - ia-flow: drop `Review` and `In Progress` (never existed in project #2).
//   - la-haus-116: add `Reviewed` (exists in project #116 but was missing
//     locally), positioned between `In Review` and `Done`.

const migration: Migration = {
  id: '030-cleanup-status-mismatch',
  description:
    'Elimina statuses locales que no existen en el GitHub ProjectV2 (ia-flow.Review, ia-flow.In Progress) y agrega los que faltaban (la-haus-116.Reviewed).',
  up(db: Database): void {
    db.run(
      "DELETE FROM statuses WHERE project_id = 'ia-flow' AND name IN ('Review', 'In Progress')",
    )

    const hasReviewed = db
      .query("SELECT name FROM statuses WHERE project_id = 'la-haus-116' AND name = 'Reviewed'")
      .get()

    if (!hasReviewed) {
      db.run(
        "UPDATE statuses SET position = position + 1 WHERE project_id = 'la-haus-116' AND name = 'Done'",
      )
      db.run(
        "INSERT INTO statuses (project_id, name, position, context_repos, agents, allow_blocked) VALUES ('la-haus-116', 'Reviewed', 6, NULL, '[]', 0)",
      )
    }
  },
}

export default migration
