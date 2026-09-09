import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, it } from 'bun:test'
import migration from '../../../../migrations/074-task-annotations.js'
import { SqliteTaskAnnotationRepository } from '../SqliteTaskAnnotationRepository.js'

// La tabla la crea la MIGRACIÓN, no un CREATE TABLE copiado acá — así este
// test también verifica que la 074 deja el esquema que el repo espera.
function setup(): { repo: SqliteTaskAnnotationRepository; db: Database } {
  const db = new Database(':memory:')
  migration.up(db)
  return { repo: new SqliteTaskAnnotationRepository(db), db }
}

const at = '2026-09-09T00:00:00.000Z'

describe('SqliteTaskAnnotationRepository', () => {
  let repo: SqliteTaskAnnotationRepository
  let db: Database

  beforeEach(() => {
    ;({ repo, db } = setup())
  })

  it('la migración crea la tabla y su índice por tarea', () => {
    const objects = db
      .query("SELECT name FROM sqlite_master WHERE name IN ('task_annotations', ?)")
      .all('idx_task_annotations_task') as { name: string }[]
    expect(objects.map((o) => o.name).sort()).toEqual([
      'idx_task_annotations_task',
      'task_annotations',
    ])
  })

  it('create + listByTask hacen ida y vuelta', async () => {
    await repo.create({
      id: 'a1',
      projectId: 'p1',
      taskId: 't1',
      text: 'Depende de #99',
      origin: 'assistant',
      createdAt: at,
    })
    expect(await repo.listByTask('p1', 't1')).toEqual([
      {
        id: 'a1',
        projectId: 'p1',
        taskId: 't1',
        text: 'Depende de #99',
        origin: 'assistant',
        createdAt: at,
      },
    ])
  })

  it('listByTask no mezcla anotaciones de otra tarea ni de otro proyecto', async () => {
    await repo.create({
      id: 'a1',
      projectId: 'p1',
      taskId: 't1',
      text: 'x',
      origin: 'assistant',
      createdAt: at,
    })
    await repo.create({
      id: 'a2',
      projectId: 'p1',
      taskId: 't2',
      text: 'y',
      origin: 'assistant',
      createdAt: at,
    })
    await repo.create({
      id: 'a3',
      projectId: 'p2',
      taskId: 't1',
      text: 'z',
      origin: 'assistant',
      createdAt: at,
    })
    const notes = await repo.listByTask('p1', 't1')
    expect(notes.map((n) => n.id)).toEqual(['a1'])
  })

  it('listByTask ordena por createdAt', async () => {
    await repo.create({
      id: 'a2',
      projectId: 'p1',
      taskId: 't1',
      text: 'segunda',
      origin: 'assistant',
      createdAt: '2026-09-09T01:00:00.000Z',
    })
    await repo.create({
      id: 'a1',
      projectId: 'p1',
      taskId: 't1',
      text: 'primera',
      origin: 'assistant',
      createdAt: '2026-09-09T00:00:00.000Z',
    })
    const notes = await repo.listByTask('p1', 't1')
    expect(notes.map((n) => n.id)).toEqual(['a1', 'a2'])
  })

  it('delete devuelve true si borró una fila, false si no existía', async () => {
    await repo.create({
      id: 'a1',
      projectId: 'p1',
      taskId: 't1',
      text: 'x',
      origin: 'assistant',
      createdAt: at,
    })
    expect(await repo.delete('a1')).toBe(true)
    expect(await repo.delete('a1')).toBe(false)
    expect(await repo.listByTask('p1', 't1')).toEqual([])
  })
})
