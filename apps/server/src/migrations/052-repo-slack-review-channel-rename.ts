import type { Migration } from './runner.js'

// Renombra `repos.slack_channel` → `repos.slack_review_channel`.
//
// El campo del repo se llamaba `slackChannel` y el del proyecto
// `slackReviewChannel` (ProjectSettingsSchema), aunque son el mismo dato en dos
// niveles con herencia por campo (ver resolveSlackReviewTarget en
// @ia-flow/shared): dos nombres para lo mismo obligaban a recordar cuál va en
// cada YAML, y escribir el del otro nivel lo descartaba en silencio — que es
// exactamente lo que pasó en el deploy `subscriptions-pipeline`.
//
// `ALTER TABLE ... RENAME COLUMN` preserva los datos; el guard hace la
// migración idempotente y no-op en una DB que ya venga renombrada.

const migration: Migration = {
  id: '052-repo-slack-review-channel-rename',
  description: 'Rename repos.slack_channel to slack_review_channel',
  up(db) {
    const cols = db.query('PRAGMA table_info(repos)').all() as { name: string }[]
    const has = (name: string) => cols.some((c) => c.name === name)
    if (has('slack_channel') && !has('slack_review_channel')) {
      db.run('ALTER TABLE repos RENAME COLUMN slack_channel TO slack_review_channel')
    } else if (!has('slack_review_channel')) {
      db.run('ALTER TABLE repos ADD COLUMN slack_review_channel TEXT')
    }
  },
}

export default migration
