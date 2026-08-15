import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, it } from 'bun:test'
import { SqliteStatusRepository } from '../SqliteStatusRepository.js'

function setup(): SqliteStatusRepository {
  const db = new Database(':memory:')
  db.run(`CREATE TABLE projects (id TEXT PRIMARY KEY NOT NULL)`)
  db.run(`INSERT INTO projects (id) VALUES ('p1')`)
  db.run(`
    CREATE TABLE statuses (
      project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name          TEXT NOT NULL,
      position      INTEGER NOT NULL DEFAULT 0,
      agents        TEXT NOT NULL DEFAULT '[]',
      allow_blocked INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (project_id, name)
    )
  `)
  return new SqliteStatusRepository(db)
}

describe('SqliteStatusRepository allowBlocked', () => {
  let repo: SqliteStatusRepository

  beforeEach(() => {
    repo = setup()
  })

  it('persists allowBlocked=true through upsert + list', () => {
    repo.upsert({ name: 'Refine', agents: [], allowBlocked: true }, 0, 'p1')
    const [row] = repo.list('p1')
    expect(row.allowBlocked).toBe(true)
  })

  it('omits allowBlocked when false (clean serialization)', () => {
    repo.upsert({ name: 'Build', agents: [] }, 0, 'p1')
    const [row] = repo.list('p1')
    expect(row.allowBlocked).toBeUndefined()
  })

  it('updates allowBlocked on subsequent upsert', () => {
    repo.upsert({ name: 'Refine', agents: [], allowBlocked: true }, 0, 'p1')
    repo.upsert({ name: 'Refine', agents: [] }, 0, 'p1')
    expect(repo.getByName('p1', 'Refine')?.allowBlocked).toBeUndefined()
  })
})
