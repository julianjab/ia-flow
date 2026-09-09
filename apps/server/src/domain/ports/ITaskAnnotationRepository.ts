import type { TaskAnnotation } from '@ia-flow/shared'

/**
 * La anotación que deja la acción `note` del asistente de tareas sobre una
 * tarea puntual — NO un comentario de GitHub: vive en `task_annotations`
 * (migración 074), es editable/borrable desde ia-flow, y siempre scopeada a
 * `(projectId, taskId)`.
 */
export interface ITaskAnnotationRepository {
  create(note: TaskAnnotation): Promise<TaskAnnotation>

  /** Las anotaciones de una tarea, más viejas primero — el mismo orden en el
   *  que se van apilando bajo la fila. */
  listByTask(projectId: string, taskId: string): Promise<TaskAnnotation[]>

  /** `false` si el id no existía (ya borrada, o nunca existió) — el caller
   *  decide si eso es un 404 o un no-op silencioso. */
  delete(id: string): Promise<boolean>
}
