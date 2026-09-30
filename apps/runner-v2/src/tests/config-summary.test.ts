/**
 * El resumen de la config que ven la web y el asistente: nunca un secreto de runner.yaml.
 */
import { describe, expect, it } from 'bun:test'
import { END } from '@ia-flow/agent-engine'
import { configSummary } from '../inbox/configSummary.js'

describe('configSummary', () => {
  const summary = configSummary({
    projects: [],
    pipelines: () => [],
    routesOf: () => ({ exits: [] }) as never,
    providers: {
      'anthropic-api': { maxTokens: 32000, maxConcurrent: 3, apiKey: 'sk-secreto' },
      'claude-tmux': { type: 'claude-cli', mode: 'tmux', maxConcurrent: 2 },
      'local-host': {
        type: 'remote',
        url: 'http://localhost:3004',
        token: 'tok-secreto',
        provider: 'claude-tmux',
      },
    },
    mcp: [
      { id: 'github-mcp', config: { url: 'https://api.githubcopilot.com/mcp/readonly' } },
      { id: 'memory-mcp', config: { url: 'https://tunnel.example.com/s3cr3t-path/mcp' } },
      { id: 'sin-resolver', config: { url: '${MEMORY_MCP_URL}' } },
    ],
  })

  it('each provider shows its type, mode, target and cap — never a token or key', () => {
    expect(summary.providers).toEqual([
      { id: 'anthropic-api', type: 'anthropic-api', max_concurrent: 3 },
      { id: 'claude-tmux', type: 'claude-cli', mode: 'tmux', max_concurrent: 2 },
      { id: 'local-host', type: 'remote', provider: 'claude-tmux' },
    ])
    expect(JSON.stringify(summary)).not.toContain('secreto')
  })

  it('each MCP shows only its host: a URL path can carry a secret', () => {
    expect(summary.mcp).toEqual([
      { id: 'github-mcp', host: 'api.githubcopilot.com' },
      { id: 'memory-mcp', host: 'tunnel.example.com' },
      { id: 'sin-resolver', host: 'del ambiente' },
    ])
    expect(JSON.stringify(summary)).not.toContain('s3cr3t')
  })

  it('onError lists the step ids: a live action carries its client, and its auth', () => {
    const update = {
      id: 'update_issue',
      auth: { privateKey: '-----BEGIN-secreto', token: 'ghs_secreto' },
    }
    const pipeline = {
      id: 'p',
      on: 'item.changed',
      trigger: { when: [] },
      exclusive: false,
      position: 0,
      do: [{ kind: 'agent', id: 'refiner', candidates: [] }],
    }
    const withError = configSummary({
      projects: [],
      pipelines: () => [{ pipeline: pipeline as never, sourceId: 'runner' }],
      routesOf: () =>
        ({ exits: [], onError: { route: { to: [update, END] }, origin: 'project' } }) as never,
    })
    expect(withError.agents[0]?.routes.onError).toBe('update_issue')
    expect(JSON.stringify(withError)).not.toContain('secreto')
  })
})
