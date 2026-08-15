import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, it } from 'bun:test'
import { SqliteRepoRepository } from '../SqliteRepoRepository.js'

function setup(): SqliteRepoRepository {
  const db = new Database(':memory:')
  db.run(`CREATE TABLE projects (id TEXT PRIMARY KEY NOT NULL)`)
  db.run(`INSERT INTO projects (id) VALUES ('p1'), ('p2')`)
  db.run(`
    CREATE TABLE repos (
      name         TEXT NOT NULL,
      path         TEXT,
      github_owner TEXT,
      github_repo  TEXT,
      workflow     TEXT,
      description  TEXT,
      project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      PRIMARY KEY (name, project_id)
    )
  `)
  return new SqliteRepoRepository(db)
}

describe('SqliteRepoRepository lookup helpers', () => {
  let repo: SqliteRepoRepository

  beforeEach(() => {
    repo = setup()
    repo.upsert({
      name: 'ia-flow',
      projectId: 'p1',
      path: '/abs/ia-flow',
      githubOwner: 'julianjab',
      githubRepo: 'ia-flow',
    })
    repo.upsert({
      name: 'ia-flow',
      projectId: 'p2',
      path: '/abs/ia-flow',
      githubOwner: 'julianjab',
      githubRepo: 'ia-flow',
    })
    repo.upsert({
      name: 'other',
      projectId: 'p1',
      path: '/abs/other',
      githubOwner: 'x',
      githubRepo: 'other',
    })
  })

  it('findByGithubRepo returns rows across projects', () => {
    const rows = repo.findByGithubRepo('julianjab', 'ia-flow')
    expect(rows.map((r) => r.projectId).sort()).toEqual(['p1', 'p2'])
  })

  it('findByGithubRepo returns [] when no match', () => {
    expect(repo.findByGithubRepo('nope', 'nope')).toEqual([])
  })

  it('findByPath returns rows across projects', () => {
    const rows = repo.findByPath('/abs/ia-flow')
    expect(rows.map((r) => r.projectId).sort()).toEqual(['p1', 'p2'])
  })

  it('findByPath returns [] when path does not match exactly', () => {
    expect(repo.findByPath('/abs/ia-flow/')).toEqual([])
    expect(repo.findByPath('/nope')).toEqual([])
  })
})
