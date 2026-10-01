import { describe, expect, it } from 'bun:test'
import { providerRegistry } from '@ia-flow/agent-engine'
import { ClaudeCliProvider } from '@ia-flow/provider-anthropic-cli'
import { agentConfigValidator, registerProviders, validateProviderDefaults } from './providers.js'

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

  it('a remote:* agent providerConfig is validated by the host, not here', () => {
    expect(agentConfigValidator(PROVIDERS)('remote:laptop')).toBeUndefined()
  })
})
