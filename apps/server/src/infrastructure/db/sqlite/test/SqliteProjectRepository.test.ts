import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'
import { SqliteProjectRepository } from '../SqliteProjectRepository.js'

function setup(): SqliteProjectRepository {
  const db = new Database(':memory:')
  db.run(`
    CREATE TABLE projects (
      id            TEXT PRIMARY KEY NOT NULL,
      name          TEXT NOT NULL,
      language      TEXT,
      source_kind   TEXT,
      source_config TEXT,
      settings      TEXT NOT NULL DEFAULT '{}',
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL,
      archived_at   TEXT
    )
  `)
  return new SqliteProjectRepository(db)
}

describe('SqliteProjectRepository.getDefaultId', () => {
  it('devuelve null cuando la tabla projects está vacía (deploy sin proyectos)', () => {
    const repo = setup()
    expect(repo.getDefaultId()).toBeNull()
  })

  it('devuelve el proyecto no archivado más antiguo', () => {
    const repo = setup()
    repo.upsert({ id: 'p1', name: 'Uno', settings: {} })
    repo.upsert({ id: 'p2', name: 'Dos', settings: {} })
    expect(repo.getDefaultId()).toBe('p1')
  })

  it('ignora proyectos archivados', () => {
    const repo = setup()
    repo.upsert({ id: 'p1', name: 'Uno', settings: {} })
    repo.archive('p1')
    repo.upsert({ id: 'p2', name: 'Dos', settings: {} })
    expect(repo.getDefaultId()).toBe('p2')
  })
})
