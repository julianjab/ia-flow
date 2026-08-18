import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, it } from 'bun:test'
import { SqliteAgentRepository } from '../SqliteAgentRepository.js'

function setup(): SqliteAgentRepository {
  const db = new Database(':memory:')
  db.run(`
    CREATE TABLE agents (
      id                 TEXT PRIMARY KEY NOT NULL,
      position           INTEGER NOT NULL DEFAULT 0,
      provider           TEXT NOT NULL,
      prompt             TEXT NOT NULL,
      variables          TEXT,
      tools              TEXT,
      save_output        INTEGER,
      system_prompts     TEXT,
      project_id         TEXT,
      provider_config    TEXT,
      mcp_catalog_ids    TEXT,
      disabled_tools     TEXT,
      requires_branch    INTEGER,
      permissions        TEXT,
      preset_id          TEXT,
      repo_name          TEXT,
      status_name        TEXT,
      when_conditions    TEXT,
      on_process         TEXT,
      on_finish          TEXT,
      on_error           TEXT,
      on_process_labels  TEXT,
      on_finish_labels   TEXT,
      on_error_labels    TEXT,
      enabled            INTEGER NOT NULL DEFAULT 1
    )
  `)
  return new SqliteAgentRepository(db)
}

describe('SqliteAgentRepository — activation + outcome columns', () => {
  let repo: SqliteAgentRepository

  beforeEach(() => {
    repo = setup()
  })

  it('round-trips repoName/statusName/when/outcomes through upsert + inScope', () => {
    repo.upsert(
      {
        id: 'reviewer',
        provider: 'anthropic',
        prompt: 'review it',
        repoName: 'backend',
        statusName: 'Review',
        when: [{ field: 'labels', op: 'includes', value: 'urgent' }],
        onProcess: '$set: status=In Review',
        onFinish: '$set: status=Done',
        onError: '$set: status=Failed',
        onProcessLabels: '$labels: add=in-review',
        onFinishLabels: '$labels: remove=in-review',
        onErrorLabels: '$labels: add=needs-attention',
      },
      0,
      'p1',
    )

    const [row] = repo.inScope('p1')
    expect(row.repoName).toBe('backend')
    expect(row.statusName).toBe('Review')
    expect(row.when).toEqual([{ field: 'labels', op: 'includes', value: 'urgent' }])
    expect(row.onProcess).toBe('$set: status=In Review')
    expect(row.onFinish).toBe('$set: status=Done')
    expect(row.onError).toBe('$set: status=Failed')
    expect(row.onProcessLabels).toBe('$labels: add=in-review')
    expect(row.onFinishLabels).toBe('$labels: remove=in-review')
    expect(row.onErrorLabels).toBe('$labels: add=needs-attention')
    expect(row.enabled).toBe(true)
  })

  it('defaults enabled to true and omits unset activation/outcome fields', () => {
    repo.upsert({ id: 'plain', provider: 'anthropic', prompt: 'go' }, 0, 'p1')
    const [row] = repo.inScope('p1')
    expect(row.enabled).toBe(true)
    expect(row.repoName).toBeUndefined()
    expect(row.statusName).toBeUndefined()
    expect(row.when).toBeUndefined()
    expect(row.onProcess).toBeUndefined()
  })

  it('persists enabled=false', () => {
    repo.upsert({ id: 'off', provider: 'anthropic', prompt: 'go', enabled: false }, 0, 'p1')
    const [row] = repo.inScope('p1')
    expect(row.enabled).toBe(false)
  })

  it('setPositions reorders within scope and ignores ids outside it', () => {
    repo.upsert({ id: 'a', provider: 'p', prompt: 'x' }, 0, 'p1')
    repo.upsert({ id: 'b', provider: 'p', prompt: 'x' }, 1, 'p1')
    repo.upsert({ id: 'c', provider: 'p', prompt: 'x' }, 0, null)

    repo.setPositions(['b', 'a', 'ghost'], 'p1')

    const scoped = repo.inScope('p1')
    expect(scoped.map((a) => a.id)).toEqual(['b', 'a'])
    // Global-scoped row untouched by a project-scoped reorder.
    expect(repo.inScope(null).map((a) => a.id)).toEqual(['c'])
  })
})
