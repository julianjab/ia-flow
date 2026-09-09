import type { Database } from 'bun:sqlite'
import type { TaskAnnotation } from '@ia-flow/shared'
import type { ITaskAnnotationRepository } from '../../../domain/ports/ITaskAnnotationRepository.js'

function rowToAnnotation(r: Record<string, unknown>): TaskAnnotation {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    taskId: r.task_id as string,
    text: r.text as string,
    origin: r.origin as TaskAnnotation['origin'],
    createdAt: r.created_at as string,
  }
}

export class SqliteTaskAnnotationRepository implements ITaskAnnotationRepository {
  constructor(private readonly db: Database) {}

  async create(note: TaskAnnotation): Promise<TaskAnnotation> {
    this.db.run(
      `INSERT INTO task_annotations (id, project_id, task_id, text, origin, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [note.id, note.projectId, note.taskId, note.text, note.origin, note.createdAt],
    )
    return note
  }

  async listByTask(projectId: string, taskId: string): Promise<TaskAnnotation[]> {
    const rows = this.db
      .query(
        'SELECT * FROM task_annotations WHERE project_id = ? AND task_id = ? ORDER BY created_at',
      )
      .all(projectId, taskId) as Record<string, unknown>[]
    return rows.map(rowToAnnotation)
  }

  async delete(id: string): Promise<boolean> {
    return this.db.run('DELETE FROM task_annotations WHERE id = ?', [id]).changes > 0
  }
}
