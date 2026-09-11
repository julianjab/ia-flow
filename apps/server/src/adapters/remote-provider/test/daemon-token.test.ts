import { afterEach, describe, expect, it } from 'bun:test'
import type { ProviderInput } from '@ia-flow/ai-providers'
import type { ProviderRegistration } from '../../../domain/ports/IProviderRegistrationRepository.js'
import { RemoteAgentProvider } from '../RemoteAgentProvider.js'

const originalFetch = globalThis.fetch
const originalToken = Bun.env.IA_FLOW_API_TOKEN

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalToken === undefined) delete Bun.env.IA_FLOW_API_TOKEN
  else Bun.env.IA_FLOW_API_TOKEN = originalToken
})

function registration(remoteKind: 'sync' | 'async'): ProviderRegistration {
  return {
    id: 'reg-1',
    name: 'mi agent-host',
    baseUrl: 'https://agent-host.example.com',
    token: 'secret-token',
    remoteKind,
    remoteName: 'x',
    remoteDescription: 'y',
    createdAt: '2026-01-01T00:00:00Z',
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

/** Corre y devuelve el body que viajó al agent-host. */
async function sentBody(
  remoteKind: 'sync' | 'async',
  input: ProviderInput,
): Promise<{ daemonToken?: string }> {
  let captured: { daemonToken?: string } = {}
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    captured = JSON.parse(String(init?.body))
    return new Response(JSON.stringify({ content: '', mode: 'api' }), { status: 200 })
  }) as typeof fetch
  await new RemoteAgentProvider(registration(remoteKind)).run(input)
  return captured
}

describe('daemonToken hacia un agent-host', () => {
  it('viaja a un remoto SYNC que declara tools — claude-print las entrega por MCP', async () => {
    // Era `kind === 'async'`, con el argumento de que un sync ejecuta sus
    // tools allá y nunca le habla a `/api/mcp`. Cierto para `anthropic-api`,
    // falso para `claude-print`: sin el token, cada tool del agente contesta
    // 401 y el run arranca sin ninguna.
    Bun.env.IA_FLOW_API_TOKEN = 'daemon-secret'

    const body = await sentBody('sync', baseInput({ tools: ['memory_store'] }))

    expect(body.daemonToken).toBe('daemon-secret')
  })

  it('sigue viajando a un remoto async', async () => {
    Bun.env.IA_FLOW_API_TOKEN = 'daemon-secret'

    const body = await sentBody('async', baseInput({ tools: ['fs_read'] }))

    expect(body.daemonToken).toBe('daemon-secret')
  })

  it('NO viaja si el agente no declara tools', async () => {
    // Abre `PUT /api/env-vars` y `POST /api/tasks` de este daemon: no se
    // manda donde no hay una conexión MCP que autenticar.
    Bun.env.IA_FLOW_API_TOKEN = 'daemon-secret'

    const body = await sentBody('sync', baseInput({ tools: [] }))

    expect(body.daemonToken).toBeUndefined()
  })
})
