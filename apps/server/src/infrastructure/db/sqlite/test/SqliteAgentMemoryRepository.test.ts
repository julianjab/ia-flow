import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, it } from 'bun:test'
import migration from '../../../../migrations/056-agent-memories.js'
import { SqliteAgentMemoryRepository } from '../SqliteAgentMemoryRepository.js'

// La tabla la crea la MIGRACIÓN, no un CREATE TABLE copiado acá: así este test
// también verifica que la 056 deja el esquema que el repo espera, y no puede
// quedar desincronizado de ella.
function setup(): { repo: SqliteAgentMemoryRepository; db: Database } {
  const db = new Database(':memory:')
  migration.up(db)
  return { repo: new SqliteAgentMemoryRepository(db), db }
}

const at = '2026-08-27T00:00:00.000Z'

describe('SqliteAgentMemoryRepository', () => {
  let repo: SqliteAgentMemoryRepository
  let db: Database

  beforeEach(() => {
    ;({ repo, db } = setup())
  })

  it('la migración crea la tabla y su índice de namespace', () => {
    const objects = db
      .query("SELECT name FROM sqlite_master WHERE name IN ('agent_memories', ?)")
      .all('idx_agent_memories_namespace') as { name: string }[]
    expect(objects.map((o) => o.name).sort()).toEqual([
      'agent_memories',
      'idx_agent_memories_namespace',
    ])
  })

  it('upsert + get hacen ida y vuelta', () => {
    repo.upsert({ agentId: 'a', projectId: 'p1', key: 'k', value: 'v', updatedAt: at })
    expect(repo.get('a', 'p1', 'k')).toEqual({
      agentId: 'a',
      projectId: 'p1',
      key: 'k',
      value: 'v',
      updatedAt: at,
    })
  })

  it('get devuelve null para una key que nunca se guardó', () => {
    expect(repo.get('a', 'p1', 'nada')).toBeNull()
  })

  it('un segundo upsert de la misma key pisa el valor en vez de duplicar la fila', () => {
    repo.upsert({ agentId: 'a', projectId: 'p1', key: 'k', value: 'v1', updatedAt: at })
    repo.upsert({
      agentId: 'a',
      projectId: 'p1',
      key: 'k',
      value: 'v2',
      updatedAt: '2026-08-28T00:00:00.000Z',
    })
    expect(repo.list('a', 'p1')).toHaveLength(1)
    expect(repo.get('a', 'p1', 'k')?.value).toBe('v2')
  })

  it('el namespace aísla agentes y proyectos con la misma key', () => {
    repo.upsert({ agentId: 'a', projectId: 'p1', key: 'k', value: 'de a/p1', updatedAt: at })
    repo.upsert({ agentId: 'b', projectId: 'p1', key: 'k', value: 'de b/p1', updatedAt: at })
    repo.upsert({ agentId: 'a', projectId: 'p2', key: 'k', value: 'de a/p2', updatedAt: at })
    repo.upsert({ agentId: 'a', projectId: '', key: 'k', value: 'global de a', updatedAt: at })

    expect(repo.get('a', 'p1', 'k')?.value).toBe('de a/p1')
    expect(repo.get('b', 'p1', 'k')?.value).toBe('de b/p1')
    expect(repo.get('a', 'p2', 'k')?.value).toBe('de a/p2')
    // `''` (global) es una fila propia y no colapsa con las de proyecto — que
    // es exactamente lo que un NULL en la primary key no garantizaría.
    expect(repo.get('a', '', 'k')?.value).toBe('global de a')
  })

  it('list devuelve sólo el namespace pedido, ordenado por key', () => {
    repo.upsert({ agentId: 'a', projectId: 'p1', key: 'zeta', value: '1', updatedAt: at })
    repo.upsert({ agentId: 'a', projectId: 'p1', key: 'alfa', value: '2', updatedAt: at })
    repo.upsert({ agentId: 'b', projectId: 'p1', key: 'beta', value: '3', updatedAt: at })

    expect(repo.list('a', 'p1').map((e) => e.key)).toEqual(['alfa', 'zeta'])
  })

  it('search matchea key o value, sin distinguir mayúsculas ni acentos ASCII', () => {
    repo.upsert({
      agentId: 'a',
      projectId: 'p1',
      key: 'deploy_channel',
      value: '#i',
      updatedAt: at,
    })
    repo.upsert({
      agentId: 'a',
      projectId: 'p1',
      key: 'owner',
      value: 'DEPLOY team',
      updatedAt: at,
    })
    repo.upsert({ agentId: 'a', projectId: 'p1', key: 'otra', value: 'nada', updatedAt: at })

    expect(repo.search('a', 'p1', 'deploy').map((e) => e.key)).toEqual(['deploy_channel', 'owner'])
  })

  it('search no cruza el namespace', () => {
    repo.upsert({ agentId: 'b', projectId: 'p1', key: 'k', value: 'deploy', updatedAt: at })
    expect(repo.search('a', 'p1', 'deploy')).toEqual([])
  })

  it('search trata los comodines de LIKE como texto literal', () => {
    repo.upsert({ agentId: 'a', projectId: 'p1', key: 'con%pct', value: 'x', updatedAt: at })
    repo.upsert({ agentId: 'a', projectId: 'p1', key: 'sin', value: 'y', updatedAt: at })

    // Sin escapar, '%' matchearía todo.
    expect(repo.search('a', 'p1', '%').map((e) => e.key)).toEqual(['con%pct'])
  })

  it('deleteByKey borra sólo esa entrada y reporta si había algo', () => {
    repo.upsert({ agentId: 'a', projectId: 'p1', key: 'k1', value: 'v1', updatedAt: at })
    repo.upsert({ agentId: 'a', projectId: 'p1', key: 'k2', value: 'v2', updatedAt: at })

    expect(repo.deleteByKey('a', 'p1', 'k1')).toBe(true)
    expect(repo.deleteByKey('a', 'p1', 'k1')).toBe(false)
    expect(repo.list('a', 'p1').map((e) => e.key)).toEqual(['k2'])
  })

  it('deleteByKey no toca la misma key de otro agente', () => {
    repo.upsert({ agentId: 'a', projectId: 'p1', key: 'k', value: 'de a', updatedAt: at })
    repo.upsert({ agentId: 'b', projectId: 'p1', key: 'k', value: 'de b', updatedAt: at })

    repo.deleteByKey('a', 'p1', 'k')
    expect(repo.get('b', 'p1', 'k')?.value).toBe('de b')
  })
})
