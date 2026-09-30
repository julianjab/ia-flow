import { describe, expect, it } from 'bun:test'
import { providerRegistry } from '@ia-flow/agent-engine'
import { ClaudeCliProvider } from '@ia-flow/provider-claude-cli'
import { RemoteProvider } from '@ia-flow/provider-remote'
import {
  agentConfigValidator,
  registerProviders,
  runnerHints,
  validateProviderDefaults,
} from '../providers/providers.js'

const PROVIDERS = {
  'anthropic-api': { maxTokens: 1000, maxConcurrent: 2 },
  'claude-tmux': { type: 'claude-cli', mode: 'tmux', model: 'opus', maxConcurrent: 1 },
}

describe('providers', () => {
  it('registers anthropic-api and every claude-cli entry under its key', () => {
    registerProviders(PROVIDERS, { cwd: async () => '/tmp', log: () => {} })
    expect(providerRegistry.resolve('anthropic-api')?.maxConcurrent).toBe(2)
    const cli = providerRegistry.resolve('claude-tmux')
    expect(cli).toBeInstanceOf(ClaudeCliProvider)
    expect(cli?.maxConcurrent).toBe(1)
  })

  it('validates each agent providerConfig against its provider', () => {
    const validatorFor = agentConfigValidator(PROVIDERS)
    expect(() => validatorFor('claude-tmux')?.({ maxTokens: 1 })).toThrow(/claude-cli inválido/)
    expect(() => validatorFor('claude-tmux')?.({ model: 'haiku' })).not.toThrow()
    expect(() => validatorFor('anthropic-api')?.({ nope: 1 })).toThrow()
    expect(validatorFor('otro')).toBeUndefined()
  })

  it('rejects a claude-cli entry with an unknown key', () => {
    expect(() =>
      validateProviderDefaults({ 'claude-x': { type: 'claude-cli', maxTokens: 1 } }),
    ).toThrow(/providers.claude-x/)
  })

  it('registers every remote entry, with its token from the environment', () => {
    process.env.TEST_REMOTE_TOKEN = 'secreto'
    const registered = registerProviders(
      {
        'gpu-box': {
          type: 'remote',
          url: 'http://gpu-box:3002',
          token: '${TEST_REMOTE_TOKEN}',
          provider: 'claude-cli',
          maxConcurrent: 3,
        },
      },
      { cwd: async () => '/tmp', log: () => {} },
    )
    const remote = providerRegistry.resolve('gpu-box')
    expect(remote).toBeInstanceOf(RemoteProvider)
    expect(remote?.maxConcurrent).toBe(3)
    expect(registered.map((provider) => provider.id)).toEqual(['anthropic-api', 'gpu-box'])
  })

  it('a remote entry without its token in the environment, or with an unknown key, breaks the boot', () => {
    delete process.env.TEST_MISSING_TOKEN
    expect(() =>
      validateProviderDefaults({
        box: { type: 'remote', url: 'http://box', token: '${TEST_MISSING_TOKEN}' },
      }),
    ).toThrow(/providers.box: falta TEST_MISSING_TOKEN/)
    expect(() =>
      validateProviderDefaults({
        box: { type: 'remote', url: 'http://box', token: 't', mode: 'x' },
      }),
    ).toThrow(/providers.box/)
  })

  it('a remote agent providerConfig is validated by the host, not here', () => {
    const validatorFor = agentConfigValidator({ box: { type: 'remote' } })
    expect(validatorFor('box')).toBeUndefined()
  })

  it('the host rules see the task repo as owner/repo', () => {
    const ctx = { event: { payload: { owner: 'la-haus', repo: 'eks' } } } as never
    expect(runnerHints(ctx)).toEqual({ repo: ['la-haus/eks'] })
    expect(runnerHints({ event: { payload: {} } } as never)).toEqual({})
  })
})
