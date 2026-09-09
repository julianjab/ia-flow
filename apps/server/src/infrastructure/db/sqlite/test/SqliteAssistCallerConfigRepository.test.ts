import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, it } from 'bun:test'
import migration from '../../../../migrations/075-assist-caller-configs.js'
import { SqliteAssistCallerConfigRepository } from '../SqliteAssistCallerConfigRepository.js'

// La tabla la crea la MIGRACIÓN, no un CREATE TABLE copiado acá — así este
// test también verifica que la 075 deja el esquema que el repo espera.
function setup(): { repo: SqliteAssistCallerConfigRepository; db: Database } {
  const db = new Database(':memory:')
  migration.up(db)
  return { repo: new SqliteAssistCallerConfigRepository(db), db }
}

describe('SqliteAssistCallerConfigRepository', () => {
  let repo: SqliteAssistCallerConfigRepository
  let db: Database

  beforeEach(() => {
    ;({ repo, db } = setup())
  })

  it('la migración crea la tabla', () => {
    const rows = db
      .query("SELECT name FROM sqlite_master WHERE name = 'assist_caller_configs'")
      .all() as { name: string }[]
    expect(rows.map((r) => r.name)).toEqual(['assist_caller_configs'])
  })

  it('getById devuelve null cuando no hay fila', () => {
    expect(repo.getById('task-chat')).toBeNull()
  })

  it('upsert + getById hacen ida y vuelta, con systemPrompts mixtos (id string + {text})', () => {
    repo.upsert({ agentId: 'task-chat', systemPrompts: ['sp1', { text: 'inline' }] })
    expect(repo.getById('task-chat')).toEqual({
      agentId: 'task-chat',
      systemPrompts: ['sp1', { text: 'inline' }],
    })
  })

  it('upsert sobre el mismo agentId reemplaza la fila (no la duplica)', () => {
    repo.upsert({ agentId: 'task-chat', systemPrompts: [{ text: 'v1' }] })
    repo.upsert({ agentId: 'task-chat', systemPrompts: [{ text: 'v2' }] })
    expect(repo.getById('task-chat')).toEqual({
      agentId: 'task-chat',
      systemPrompts: [{ text: 'v2' }],
    })
    expect(repo.list()).toHaveLength(1)
  })

  it('list devuelve todas las filas ordenadas por agentId', () => {
    repo.upsert({ agentId: 'repo-description', systemPrompts: [] })
    repo.upsert({ agentId: 'task-chat', systemPrompts: [{ text: 'x' }] })
    expect(repo.list().map((c) => c.agentId)).toEqual(['repo-description', 'task-chat'])
  })

  it('deleteById borra la fila', () => {
    repo.upsert({ agentId: 'task-chat', systemPrompts: [{ text: 'x' }] })
    repo.deleteById('task-chat')
    expect(repo.getById('task-chat')).toBeNull()
  })
})
