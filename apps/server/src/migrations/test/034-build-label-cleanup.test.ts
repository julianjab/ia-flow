import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, it } from 'bun:test'
import m034 from '../034-build-label-cleanup.js'

type AgentEntry = {
  agent: string
  onFinish?: string
  onError?: string
  onFinishLabels?: string
  when?: unknown
}

function setup(): Database {
  const db = new Database(':memory:')
  db.run(`CREATE TABLE projects (id TEXT PRIMARY KEY NOT NULL)`)
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
  return db
}

function seedBuild(db: Database, agents: AgentEntry[]): void {
  db.run(`INSERT OR IGNORE INTO projects (id) VALUES ('la-haus-116')`)
  db.run(
    `INSERT INTO statuses (project_id, name, position, agents) VALUES ('la-haus-116', 'Build', 0, ?)`,
    [JSON.stringify(agents)],
  )
}

function readBuildAgents(db: Database): AgentEntry[] {
  const row = db
    .query<{ agents: string }, []>(
      "SELECT agents FROM statuses WHERE project_id = 'la-haus-116' AND name = 'Build'",
    )
    .get()
  if (!row) throw new Error('la-haus-116/Build row missing')
  return JSON.parse(row.agents) as AgentEntry[]
}

describe('migration 034 build-label-cleanup', () => {
  let db: Database

  beforeEach(() => {
    db = setup()
  })

  it('exposes stable id and description', () => {
    expect(m034.id).toBe('034-build-label-cleanup')
    expect(m034.description).toContain('onFinishLabels')
    expect(m034.description).toContain('$labels:-ci-checked')
  })

  it('adds onFinishLabels: "$labels:-ci-checked" to the lh116-implementer entry', () => {
    seedBuild(db, [
      {
        agent: 'lh116-implementer',
        onFinish: '$set:Status=In Review',
        onError: '$set:Status=Build',
      },
    ])

    m034.up(db)

    const [entry] = readBuildAgents(db)
    expect(entry.agent).toBe('lh116-implementer')
    expect(entry.onFinishLabels).toBe('$labels:-ci-checked')
    // Preserva las demás keys del entry sin tocarlas.
    expect(entry.onFinish).toBe('$set:Status=In Review')
    expect(entry.onError).toBe('$set:Status=Build')
  })

  it('is idempotent: re-running does not duplicate nor mutate the value', () => {
    seedBuild(db, [{ agent: 'lh116-implementer', onFinish: '$set:Status=In Review' }])

    m034.up(db)
    const afterFirst = readBuildAgents(db)
    m034.up(db)
    const afterSecond = readBuildAgents(db)

    expect(afterSecond).toEqual(afterFirst)
    expect(afterSecond[0].onFinishLabels).toBe('$labels:-ci-checked')
    // Exactly one entry survived — no accidental duplication.
    expect(afterSecond).toHaveLength(1)
  })

  it('does not overwrite an existing onFinishLabels with a different value', () => {
    seedBuild(db, [
      {
        agent: 'lh116-implementer',
        onFinish: '$set:Status=In Review',
        onFinishLabels: '$labels:-custom-label',
      },
    ])

    m034.up(db)

    const [entry] = readBuildAgents(db)
    expect(entry.onFinishLabels).toBe('$labels:-custom-label')
  })

  it('only touches the lh116-implementer entry (does not leak to other agents)', () => {
    seedBuild(db, [
      { agent: 'lh116-implementer', onFinish: '$set:Status=In Review' },
      { agent: 'lh116-some-future-helper', onFinish: '$set:Status=In Review' },
    ])

    m034.up(db)

    const [implementer, helper] = readBuildAgents(db)
    expect(implementer.onFinishLabels).toBe('$labels:-ci-checked')
    expect(helper.onFinishLabels).toBeUndefined()
  })

  it('early-returns without throwing when la-haus-116/Build row is missing', () => {
    // No seedBuild call — statuses table is empty for la-haus-116.
    expect(() => m034.up(db)).not.toThrow()
  })
})
