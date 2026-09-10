import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, it } from 'bun:test'
import type { ProviderRegistration } from '../../../../domain/ports/IProviderRegistrationRepository.js'
import { SqliteProviderRegistrationRepository } from '../SqliteProviderRegistrationRepository.js'

function setup(): SqliteProviderRegistrationRepository {
  const db = new Database(':memory:')
  db.run(`
    CREATE TABLE provider_registrations (
      id                   TEXT PRIMARY KEY NOT NULL,
      name                 TEXT NOT NULL,
      base_url             TEXT NOT NULL,
      token                TEXT NOT NULL,
      remote_kind          TEXT NOT NULL,
      remote_name          TEXT NOT NULL,
      remote_description   TEXT NOT NULL,
      created_at           TEXT NOT NULL,
      system_prompt        TEXT
    )
  `)
  return new SqliteProviderRegistrationRepository(db)
}

function registration(overrides: Partial<ProviderRegistration> = {}): ProviderRegistration {
  return {
    id: 'reg-1',
    name: 'mi agent-host',
    baseUrl: 'https://agent-host.example.com',
    token: 'secret-token',
    remoteKind: 'sync',
    remoteName: 'Claude Print',
    remoteDescription: 'invoca claude -p',
    createdAt: '2026-01-01T00:00:00Z',
    systemPrompt: null,
    ...overrides,
  }
}

describe('SqliteProviderRegistrationRepository', () => {
  let repo: SqliteProviderRegistrationRepository

  beforeEach(() => {
    repo = setup()
  })

  it('list() vacío por default', () => {
    expect(repo.list()).toEqual([])
  })

  it('insert + get round-trips todos los campos', () => {
    repo.insert(registration())
    expect(repo.get('reg-1')).toEqual(registration())
  })

  it('get() de un id inexistente → null', () => {
    expect(repo.get('nope')).toBeNull()
  })

  it('list() ordena por created_at', () => {
    repo.insert(registration({ id: 'b', createdAt: '2026-01-02T00:00:00Z' }))
    repo.insert(registration({ id: 'a', createdAt: '2026-01-01T00:00:00Z' }))
    expect(repo.list().map((r) => r.id)).toEqual(['a', 'b'])
  })

  it('deleteById remueve la fila', () => {
    repo.insert(registration())
    repo.deleteById('reg-1')
    expect(repo.get('reg-1')).toBeNull()
    expect(repo.list()).toEqual([])
  })

  it('deleteById de un id inexistente es un no-op', () => {
    repo.insert(registration())
    repo.deleteById('nope')
    expect(repo.list().length).toBe(1)
  })

  it('insert + get round-trips un systemPrompt id de catálogo', () => {
    repo.insert(registration({ systemPrompt: 'sp-1' }))
    expect(repo.get('reg-1')?.systemPrompt).toBe('sp-1')
  })

  it('insert + get round-trips un systemPrompt inline', () => {
    repo.insert(registration({ systemPrompt: { text: 'Corré con cuidado en esta VM' } }))
    expect(repo.get('reg-1')?.systemPrompt).toEqual({ text: 'Corré con cuidado en esta VM' })
  })

  it('updateSystemPrompt lo persiste y updateSystemPrompt(null) lo limpia', () => {
    repo.insert(registration())
    repo.updateSystemPrompt('reg-1', 'sp-1')
    expect(repo.get('reg-1')?.systemPrompt).toBe('sp-1')

    repo.updateSystemPrompt('reg-1', null)
    expect(repo.get('reg-1')?.systemPrompt).toBeNull()
  })
})
