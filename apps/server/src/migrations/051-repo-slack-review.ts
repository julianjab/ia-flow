import type { Migration } from './runner.js'

// Config del pedido de review en Slack, por repo.
//
// Va en `repos` y no en una tabla aparte porque "a quién hay que taguear para
// revisar esto" es una propiedad del código, igual que su owner de GitHub o su
// workflow — no una entidad con vida propia. Los dos campos caen a
// `project.settings` cuando el repo no los define (ver resolveSlackReviewTarget
// en @ia-flow/shared), así que un proyecto entero se configura una vez.
//
// `slack_reviewers` es JSON (`SlackMemberRef[]`) y no una tabla de join: se lee
// y se escribe siempre entero, junto con el resto de la fila del repo, y nadie
// consulta "en qué repos es reviewer X".

const migration: Migration = {
  id: '051-repo-slack-review',
  description: 'Add slack_channel + slack_reviewers to repos',
  up(db) {
    const cols = db.query('PRAGMA table_info(repos)').all() as { name: string }[]
    const has = (name: string) => cols.some((c) => c.name === name)
    if (!has('slack_channel')) db.run('ALTER TABLE repos ADD COLUMN slack_channel TEXT')
    if (!has('slack_reviewers')) db.run('ALTER TABLE repos ADD COLUMN slack_reviewers TEXT')
  },
}

export default migration
