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
      slack_review_channel TEXT,
      slack_reviewers TEXT,
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

  // `slack_reviewers` es un blob JSON: el round-trip es lo único que garantiza
  // que lo que se guardó vuelva como objetos y no como el string crudo.
  it('round-trips la config de review de Slack', () => {
    repo.upsert({
      name: 'ia-flow',
      projectId: 'p1',
      slackReviewChannel: 'C0123',
      slackReviewers: [
        { id: 'U1', name: 'juli' },
        { id: 'B2', name: 'reviewer-bot', isBot: true },
      ],
    })
    const row = repo.getByProject('ia-flow', 'p1')
    expect(row?.slackReviewChannel).toBe('C0123')
    expect(row?.slackReviewers).toEqual([
      { id: 'U1', name: 'juli' },
      { id: 'B2', name: 'reviewer-bot', isBot: true },
    ])
  })

  it('un repo sin config de Slack no trae los campos', () => {
    const row = repo.getByProject('other', 'p1')
    expect(row?.slackReviewChannel).toBeUndefined()
    expect(row?.slackReviewers).toBeUndefined()
  })

  // Una fila editada a mano en el SQLite no debería tumbar el listado de repos:
  // el pedido de review es una feature, el editor de repos es el camino crítico.
  it('un JSON corrupto en slack_reviewers se lee como "sin reviewers"', () => {
    const db = new Database(':memory:')
    db.run(`CREATE TABLE projects (id TEXT PRIMARY KEY NOT NULL)`)
    db.run(`INSERT INTO projects (id) VALUES ('p1')`)
    db.run(`
      CREATE TABLE repos (
        name TEXT NOT NULL, path TEXT, github_owner TEXT, github_repo TEXT,
        workflow TEXT, description TEXT, slack_review_channel TEXT, slack_reviewers TEXT,
        project_id TEXT NOT NULL, PRIMARY KEY (name, project_id)
      )`)
    db.run(`INSERT INTO repos (name, project_id, slack_reviewers) VALUES ('x', 'p1', '{no json')`)
    expect(new SqliteRepoRepository(db).getByProject('x', 'p1')?.slackReviewers).toBeUndefined()
  })
})
