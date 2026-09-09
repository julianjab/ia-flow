import { describe, expect, it } from 'bun:test'
import type { AssistCallerConfig, SystemPromptDef } from '@ia-flow/shared'
import type { IAssistCallerConfigRepository } from '../../domain/ports/IAssistCallerConfigRepository.js'
import type { ISystemPromptRepository } from '../../domain/ports/ISystemPromptRepository.js'
import { createAssistConfigsRouter } from '../assist-configs.js'

function fakeRepo(seed: AssistCallerConfig[] = []): IAssistCallerConfigRepository {
  const rows = [...seed]
  return {
    list: () => [...rows],
    getById: (agentId) => rows.find((r) => r.agentId === agentId) ?? null,
    upsert: (config) => {
      const idx = rows.findIndex((r) => r.agentId === config.agentId)
      if (idx >= 0) rows[idx] = config
      else rows.push(config)
    },
    deleteById: (agentId) => {
      const idx = rows.findIndex((r) => r.agentId === agentId)
      if (idx >= 0) rows.splice(idx, 1)
    },
  }
}

function fakeSystemPromptRepo(prompts: SystemPromptDef[] = []): ISystemPromptRepository {
  return {
    getById: (id: string) => prompts.find((p) => p.id === id) ?? null,
    inScope: () => prompts,
    visibleTo: () => prompts,
    upsert: () => {},
    deleteById: () => {},
    clearScope: () => {},
  } as unknown as ISystemPromptRepository
}

describe('CRUD /api/assist-configs', () => {
  it('GET / lista las configs', async () => {
    const app = createAssistConfigsRouter(
      fakeRepo([{ agentId: 'task-chat', systemPrompts: [{ text: 'x' }] }]),
      fakeSystemPromptRepo(),
    )
    const res = await app.request('/')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { configs: AssistCallerConfig[] }
    expect(body.configs.map((c) => c.agentId)).toEqual(['task-chat'])
  })

  it('GET /:agentId 404 cuando no existe', async () => {
    const app = createAssistConfigsRouter(fakeRepo(), fakeSystemPromptRepo())
    const res = await app.request('/task-chat')
    expect(res.status).toBe(404)
  })

  it('GET /:agentId 200 cuando existe', async () => {
    const app = createAssistConfigsRouter(
      fakeRepo([{ agentId: 'task-chat', systemPrompts: [{ text: 'x' }] }]),
      fakeSystemPromptRepo(),
    )
    const res = await app.request('/task-chat')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { config: AssistCallerConfig }
    expect(body.config).toEqual({ agentId: 'task-chat', systemPrompts: [{ text: 'x' }] })
  })

  it('PUT /:agentId crea o reemplaza, tomando el agentId de la URL (no del body)', async () => {
    const repo = fakeRepo()
    const app = createAssistConfigsRouter(repo, fakeSystemPromptRepo())
    const res = await app.request('/task-chat', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentId: 'otro-id-ignorado',
        systemPrompts: [{ text: 'rol estático' }],
      }),
    })
    expect(res.status).toBe(200)
    expect(repo.getById('task-chat')).toEqual({
      agentId: 'task-chat',
      systemPrompts: [{ text: 'rol estático' }],
    })
    expect(repo.getById('otro-id-ignorado')).toBeNull()
  })

  it('PUT /:agentId acepta un id string que SÍ existe en el catálogo', async () => {
    const repo = fakeRepo()
    const app = createAssistConfigsRouter(
      repo,
      fakeSystemPromptRepo([{ id: 'sp1', name: 'x', text: 'y' }]),
    )
    const res = await app.request('/task-chat', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ systemPrompts: ['sp1'] }),
    })
    expect(res.status).toBe(200)
    expect(repo.getById('task-chat')).toEqual({ agentId: 'task-chat', systemPrompts: ['sp1'] })
  })

  it('PUT /:agentId 400 con systemPrompts inválido (shape)', async () => {
    const app = createAssistConfigsRouter(fakeRepo(), fakeSystemPromptRepo())
    const res = await app.request('/task-chat', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ systemPrompts: [{ badShape: true }] }),
    })
    expect(res.status).toBe(400)
  })

  it('PUT /:agentId 400 con un id de system prompt que no existe en ningún catálogo', async () => {
    const repo = fakeRepo()
    const app = createAssistConfigsRouter(repo, fakeSystemPromptRepo([]))
    const res = await app.request('/task-chat', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ systemPrompts: ['no-existe'] }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('no-existe')
    expect(repo.getById('task-chat')).toBeNull()
  })

  it('DELETE /:agentId 200 cuando existe, 404 cuando no', async () => {
    const repo = fakeRepo([{ agentId: 'task-chat', systemPrompts: [] }])
    const app = createAssistConfigsRouter(repo, fakeSystemPromptRepo())
    const ok = await app.request('/task-chat', { method: 'DELETE' })
    expect(ok.status).toBe(200)
    const missing = await app.request('/task-chat', { method: 'DELETE' })
    expect(missing.status).toBe(404)
  })
})
