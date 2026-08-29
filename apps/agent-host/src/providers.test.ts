import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createProvider } from './providers.js'

const originalAgentHostProvider = Bun.env.AGENT_HOST_PROVIDER

beforeEach(() => {
  delete Bun.env.AGENT_HOST_PROVIDER
})

afterEach(() => {
  if (originalAgentHostProvider === undefined) delete Bun.env.AGENT_HOST_PROVIDER
  else Bun.env.AGENT_HOST_PROVIDER = originalAgentHostProvider
})

describe('createProvider', () => {
  it('sin AGENT_HOST_PROVIDER seteado, resuelve anthropic-api por default', () => {
    const provider = createProvider()
    expect(provider.id).toBe('anthropic-api')
    expect(provider.kind).toBe('sync')
  })

  it('AGENT_HOST_PROVIDER=claude-print resuelve claude-print', () => {
    Bun.env.AGENT_HOST_PROVIDER = 'claude-print'
    const provider = createProvider()
    expect(provider.id).toBe('claude-print')
    expect(provider.kind).toBe('sync')
  })

  it('AGENT_HOST_PROVIDER con un valor desconocido cae al default (anthropic-api)', () => {
    Bun.env.AGENT_HOST_PROVIDER = 'algo-que-no-existe'
    const provider = createProvider()
    expect(provider.id).toBe('anthropic-api')
  })
})
