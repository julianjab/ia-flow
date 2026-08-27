import type { Migration } from './runner.js'

// Agrega `agents.comment` — el destino por defecto de TODOS los comentarios de
// un agente (`AgentOutcomesSchema.comment`: `issue` | `pr` | `pr-else-issue`).
//
// El campo existía en el schema, en el engine (`resolveCommentTarget`) y en el
// editor web (OutcomesEditor.vue lo dibuja), pero NO en esta tabla: la 050, que
// trajo `exits`, no lo incluyó. O sea que un agente marcado `comment: issue`
// desde la UI guardaba sin error y volvía en `pr-else-issue` — un refiner
// mandando el PRD al PR en vez del issue, sin nada en los logs. En YAML sí
// funcionaba, así que el bug sólo aparecía en las instancias con SQLite.
//
// Sin backfill: NULL ⇒ `undefined` ⇒ el default de siempre (`pr-else-issue`),
// que es exactamente el comportamiento que estas filas ya tenían.

const migration: Migration = {
  id: '055-agent-comment-target',
  description: 'Add agents.comment (default comment target per agent)',
  up(db) {
    const cols = db.query('PRAGMA table_info(agents)').all() as { name: string }[]
    if (!cols.some((c) => c.name === 'comment')) {
      db.run('ALTER TABLE agents ADD COLUMN comment TEXT')
    }
  },
}

export default migration
