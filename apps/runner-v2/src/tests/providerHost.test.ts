import { describe, expect, it } from 'bun:test'
import { EventBus, type Provider } from '@ia-flow/agent-engine'
import { RemoteProvider } from '@ia-flow/provider-remote'
import { createProviderHost, hostedProviders } from '../providers/providerHost.js'

const local = (id: string): Provider => ({ id, run: async () => ({ outcome: 'success' }) })
const remote = new RemoteProvider({ id: 'box', url: 'http://box', token: 't' })

describe('providerHost', () => {
  it('exposes every local provider by default, never a remote one', () => {
    const hosted = hostedProviders([local('anthropic-api'), local('claude-cli'), remote], {})
    expect(hosted.map((provider) => provider.id)).toEqual(['anthropic-api', 'claude-cli'])
  })

  it('host.providers picks which, and an unknown one breaks the boot', () => {
    const registered = [local('anthropic-api'), local('claude-cli'), remote]
    expect(hostedProviders(registered, { providers: ['claude-cli'] }).map((p) => p.id)).toEqual([
      'claude-cli',
    ])
    expect(() => hostedProviders(registered, { providers: ['box'] })).toThrow(
      /"box" no es un provider local \(hay: anthropic-api, claude-cli\)/,
    )
  })

  it('refuses to start without a token', () => {
    expect(() => createProviderHost([local('a')], {}, undefined)).toThrow(
      /IA_FLOW_PROVIDER_HOST_TOKEN/,
    )
  })

  it('applies host.rules to the probe of a runner', async () => {
    const host = createProviderHost(
      [local('claude-cli')],
      { rules: [{ field: 'repo', op: 'matches', value: 'la-haus/*' }] },
      'secreto',
    )
    const client = new RemoteProvider({
      id: 'box',
      provider: 'claude-cli',
      url: 'http://host.test',
      token: 'secreto',
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) =>
        host.fetch(new Request(input, init))) as typeof fetch,
      hints: (ctx) => ({ repo: [String((ctx.event.payload as { repo: string }).repo)] }),
    })
    const ctx = (repo: string) => ({
      event: { type: 'github.issues', payload: { repo }, occurredAt: '', depth: 0 },
      steps: {},
      bus: new EventBus(),
      pipelineId: 'build',
    })

    expect(await client.canAccept({ agentId: 'a', ctx: ctx('la-haus/eks') })).toEqual({
      accept: true,
    })
    expect(await client.canAccept({ agentId: 'a', ctx: ctx('otra/eks') })).toMatchObject({
      accept: false,
    })
    host.close()
  })
})
