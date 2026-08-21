import { afterEach, describe, expect, it } from 'bun:test'
import type { ProviderInput } from '@ia-flow/ai-providers'
import type { ProviderRegistration } from '../../../domain/ports/IProviderRegistrationRepository.js'
import { RemoteAgentProvider, remoteProviderId } from '../RemoteAgentProvider.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function registration(overrides: Partial<ProviderRegistration> = {}): ProviderRegistration {
  return {
    id: 'reg-1',
    name: 'mi gateway',
    baseUrl: 'https://gateway.example.com',
    remoteProviderId: 'claude-print',
    token: 'secret-token',
    remoteKind: 'sync',
    remoteName: 'Claude Print',
    remoteDescription: 'invoca claude -p',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function baseInput(overrides: Partial<ProviderInput> = {}): ProviderInput {
  return {
    step: 'implement',
    taskId: 't1',
    taskTitle: 'x',
    taskDescription: '',
    taskType: 'functional',
    repos: [],
    repoPaths: {},
    prompt: 'hola',
    ...overrides,
  }
}

describe('remoteProviderId', () => {
  it('namespacea con el prefijo remote:', () => {
    expect(remoteProviderId('abc')).toBe('remote:abc')
  })
})

describe('RemoteAgentProvider', () => {
  it('id/kind/name/description se derivan de la registración', () => {
    const provider = new RemoteAgentProvider(registration())
    expect(provider.id).toBe('remote:reg-1')
    expect(provider.kind).toBe('sync')
    expect(provider.name).toBe('Claude Print (mi gateway)')
    expect(provider.description).toBe('invoca claude -p')
  })

  it('run() hace POST a <baseUrl>/v1/providers/<remoteProviderId>/run con bearer token', async () => {
    let capturedUrl: string | undefined
    let capturedHeaders: Record<string, string> | undefined
    let capturedBody: unknown
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      capturedUrl = url
      capturedHeaders = init.headers as Record<string, string>
      capturedBody = JSON.parse(init.body as string)
      return new Response(JSON.stringify({ content: 'listo', mode: 'api' }), { status: 200 })
    }) as unknown as typeof fetch

    const provider = new RemoteAgentProvider(registration())
    const output = await provider.run(baseInput({ prompt: 'hacé esto' }))

    expect(capturedUrl).toBe('https://gateway.example.com/v1/providers/claude-print/run')
    expect(capturedHeaders?.authorization).toBe('Bearer secret-token')
    expect((capturedBody as { prompt: string }).prompt).toBe('hacé esto')
    expect(output).toEqual({ content: 'listo', mode: 'api' })
  })

  it('respuesta no-2xx → lanza con el body y el id del provider', async () => {
    globalThis.fetch = (async () =>
      new Response('gateway caído', { status: 502 })) as unknown as typeof fetch

    const provider = new RemoteAgentProvider(registration())
    await expect(provider.run(baseInput())).rejects.toThrow(/remote:reg-1.*502.*gateway caído/s)
  })
})
