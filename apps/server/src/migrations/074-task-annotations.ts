import type { Migration } from './runner.js'

// Crea `task_annotations` — la anotación que la acción `note` del asistente
// de tareas deja sobre una tarea (ver #215/#216). NO es un comentario de
// GitHub: es editable/borrable desde ia-flow, con timestamp y marca de
// origen, y vive por (project_id, task_id).
//
// Sólo ESTRUCTURA: la tabla nace vacía. Nada que sembrar (ver la regla de
// migraciones en el CLAUDE.md de la raíz).
//
// Sin FK a `tasks`/`projects`: igual criterio que `agent_memories` — no hay
// FKs entre las entidades principales hoy, y una anotación huérfana tras un
// borrado es preferible a un DELETE que falla.

const migration: Migration = {
  id: '074-task-annotations',
  description: 'Create task_annotations table (nota persistente de la acción `note` del asistente)',
  up(db) {
    db.run(`
      CREATE TABLE IF NOT EXISTS task_annotations (
        id         TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL,
        task_id    TEXT NOT NULL,
        text       TEXT NOT NULL,
        origin     TEXT NOT NULL DEFAULT 'assistant',
        created_at TEXT NOT NULL
      )
    `)
    db.run(`
      CREATE INDEX IF NOT EXISTS idx_task_annotations_task
        ON task_annotations(project_id, task_id)
    `)
  },
}

export default migration
