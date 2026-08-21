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
      allow_blocked      INTEGER NOT NULL DEFAULT 0,
      when_conditions    TEXT,
      when_text          TEXT,
      on_process         TEXT,
      on_finish          TEXT,
      on_error           TEXT,
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
        allowBlocked: true,
        when: [{ field: 'labels', op: 'includes', value: 'urgent' }],
        onProcess: '$set:status=In Review,Labels=+in-review',
        onFinish: '$set:status=Done,Labels=-in-review',
        onError: '$set:status=Failed,Labels=+needs-attention',
      },
      0,
      'p1',
    )

    const [row] = repo.inScope('p1')
    expect(row.repoName).toBe('backend')
    expect(row.statusName).toBe('Review')
    expect(row.allowBlocked).toBe(true)
    expect(row.when).toEqual([{ field: 'labels', op: 'includes', value: 'urgent' }])
    expect(row.onProcess).toBe('$set:status=In Review,Labels=+in-review')
    expect(row.onFinish).toBe('$set:status=Done,Labels=-in-review')
    expect(row.onError).toBe('$set:status=Failed,Labels=+needs-attention')
    expect(row.enabled).toBe(true)
  })

  it('defaults enabled to true and omits unset activation/outcome fields', () => {
    repo.upsert({ id: 'plain', provider: 'anthropic', prompt: 'go' }, 0, 'p1')
    const [row] = repo.inScope('p1')
    expect(row.enabled).toBe(true)
    expect(row.repoName).toBeUndefined()
    expect(row.statusName).toBeUndefined()
    expect(row.allowBlocked).toBe(false)
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

  // Las posiciones NO están normalizadas a 0..n-1: la migración 036 las asignó
  // desde un contador global que atraviesa proyectos y globales, así que un
  // scope puede perfectamente vivir en 12..14. Editar un agente debe conservar
  // su posición — usar el índice dentro del scope lo mandaría al frente de la
  // selección sin que nadie lo pidiera.
  it('un upsert de edición conserva la posición y no reordena el scope', () => {
    repo.upsert({ id: 'a', provider: 'p', prompt: 'x' }, 12, 'p1')
    repo.upsert({ id: 'b', provider: 'p', prompt: 'x' }, 13, 'p1')
    repo.upsert({ id: 'c', provider: 'p', prompt: 'x' }, 14, 'p1')

    const before = repo.inScope('p1')
    const third = before[2]
    expect(third.id).toBe('c')

    // Editar sólo el prompt, preservando la posición leída de la fila actual.
    repo.upsert({ ...third, prompt: 'prompt nuevo' }, third.position ?? 0, 'p1')

    const after = repo.inScope('p1')
    expect(after.map((a) => a.id)).toEqual(['a', 'b', 'c'])
    expect(after.map((a) => a.position)).toEqual([12, 13, 14])
    expect(after[2].prompt).toBe('prompt nuevo')
  })
})

describe('SqliteAgentRepository — provider (string | AgentProviderChoice[]) + whenText', () => {
  let repo: SqliteAgentRepository

  beforeEach(() => {
    repo = setup()
  })

  it('round-trips provider como string plano — regresión: no rompe agentes existentes', () => {
    repo.upsert({ id: 'a', provider: 'anthropic-api', prompt: 'x' }, 0, 'p1')
    const [row] = repo.inScope('p1')
    expect(row.provider).toBe('anthropic-api')
  })

  it('round-trips provider como array de candidatos (serializado a JSON en la misma columna TEXT)', () => {
    repo.upsert(
      {
        id: 'a',
        provider: [
          { providerId: 'anthropic-api', whenText: 'simple' },
          { providerId: 'tmux-claude', when: [{ field: 'type', op: '=', value: 'technical' }] },
        ],
        prompt: 'x',
      },
      0,
      'p1',
    )
    const [row] = repo.inScope('p1')
    expect(row.provider).toEqual([
      { providerId: 'anthropic-api', whenText: 'simple' },
      { providerId: 'tmux-claude', when: [{ field: 'type', op: '=', value: 'technical' }] },
    ])
  })

  it('round-trips whenText a nivel de agente', () => {
    repo.upsert(
      { id: 'a', provider: 'p', prompt: 'x', whenText: 'para issues de producto' },
      0,
      'p1',
    )
    const [row] = repo.inScope('p1')
    expect(row.whenText).toBe('para issues de producto')
  })

  it('whenText ausente → undefined, no null ni string vacío', () => {
    repo.upsert({ id: 'a', provider: 'p', prompt: 'x' }, 0, 'p1')
    const [row] = repo.inScope('p1')
    expect(row.whenText).toBeUndefined()
  })
})
