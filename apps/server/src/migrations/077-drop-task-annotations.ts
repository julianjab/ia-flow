import type { Migration } from './runner.js'

// Revierte la migración 074: la acción `note` del asistente de tareas pasó a
// ser client-side (localStorage, ver `apps/web/src/features/tasks/taskNotePref.ts`)
// y ya no se persiste en el server. El use-case, la ruta, el repo
// (`ITaskAnnotationRepository`/`SqliteTaskAnnotationRepository`) y el schema
// compartido (`TaskAnnotationSchema`) ya se eliminaron; esta migración limpia
// lo que queda de estructura en la base.
//
// 074 queda intacta como historia inmutable — los números no se reutilizan.

const migration: Migration = {
  id: '077-drop-task-annotations',
  description: 'Drop task_annotations table (la nota del asistente pasó a ser client-side)',
  up(db) {
    db.run('DROP INDEX IF EXISTS idx_task_annotations_task')
    db.run('DROP TABLE IF EXISTS task_annotations')
  },
}

export default migration
