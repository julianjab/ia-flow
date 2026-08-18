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
    repo.upsert({ name: 'Refine', allowBlocked: true }, 0, 'p1')
    const [row] = repo.list('p1')
    expect(row.allowBlocked).toBe(true)
  })

  it('omits allowBlocked when false (clean serialization)', () => {
    repo.upsert({ name: 'Build' }, 0, 'p1')
    const [row] = repo.list('p1')
    expect(row.allowBlocked).toBeUndefined()
  })

  it('updates allowBlocked on subsequent upsert', () => {
    repo.upsert({ name: 'Refine', allowBlocked: true }, 0, 'p1')
    repo.upsert({ name: 'Refine' }, 0, 'p1')
    expect(repo.getByName('p1', 'Refine')?.allowBlocked).toBeUndefined()
  })
})

describe('SqliteStatusRepository position', () => {
  it('exposes position on list and getByName', () => {
    const repo = setup()
    repo.upsert({ name: 'Refine' }, 0, 'p1')
    repo.upsert({ name: 'Build' }, 1, 'p1')
    const [refine, build] = repo.list('p1')
    expect(refine.position).toBe(0)
    expect(build.position).toBe(1)
    expect(repo.getByName('p1', 'Build')?.position).toBe(1)
  })
})
