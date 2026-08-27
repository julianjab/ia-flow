import type { Migration } from './runner.js'

// Plantillas del pedido de review en Slack, por repo.
//
// Una columna JSON (`{ first?, reReview? }`) y no dos TEXT sueltas porque son
// la misma decisión —"cómo hablamos cuando pedimos review"— en sus dos
// momentos, y porque el campo homónimo de `project.settings` (que es un bag
// JSON) se mergea por una sola key: dos formas distintas para el mismo dato
// obligarían a recordar cuál va en cada nivel, que es exactamente el problema
// que arregló la 052.
//
// Vacío ⇒ hereda del proyecto, y de ahí al texto histórico
// (`DEFAULT_SLACK_REVIEW_MESSAGES` en @ia-flow/shared): nadie que no configure
// nada ve un cambio.

const migration: Migration = {
  id: '054-repo-slack-review-message',
  description: 'Add slack_review_message to repos',
  up(db) {
    const cols = db.query('PRAGMA table_info(repos)').all() as { name: string }[]
    if (!cols.some((c) => c.name === 'slack_review_message')) {
      db.run('ALTER TABLE repos ADD COLUMN slack_review_message TEXT')
    }
  },
}

export default migration
