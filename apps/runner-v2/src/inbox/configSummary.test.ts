/**
 * El resumen de la config que ven la web y el asistente: nunca un secreto de runner.yaml.
 */
import { describe, expect, it } from 'bun:test'
import { END } from '@ia-flow/agent-engine'
import { configSummary, PROMPT_PREVIEW_CHARS } from './configSummary.js'

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
      do: [
        {
          kind: 'agent',
          id: 'refiner',
          candidates: [],
          definition: { prompt: 'x' },
          toolset: { names: [] },
        },
      ],
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

  describe('what each agent has', () => {
    const long = 'Reglas. '.repeat(400)
    const refiner = {
      kind: 'agent',
      id: 'refiner',
      candidates: [
        { id: 'anthropic-api', config: { model: 'claude-opus-5-5', apiKey: 'sk-secreto' } },
        { id: 'claude-tmux', config: {} },
        { id: 'local-host', config: {} },
        { id: 'otro', config: {} },
      ],
      definition: {
        prompt: 'Refiná {{task.ref}}',
        systemPrompts: [{ id: 'reglas', text: long }, { text: 'Propio.' }],
        mcpServers: [
          {
            id: 'github',
            config: { url: 'https://mcp.example.com/s3cr3t', authorizationToken: 'tok' },
          },
        ],
        unavailableMcpServers: ['figma'],
      },
      toolset: { names: ['read_file', 'add_comment'] },
    }
    const source = {
      projects: [],
      pipelines: () => [
        {
          pipeline: {
            id: 'p',
            on: 'item.changed',
            trigger: { when: [] },
            exclusive: false,
            position: 0,
            do: [refiner],
          } as never,
          sourceId: 'runner',
        },
      ],
      routesOf: () => ({ exits: [] }) as never,
      providers: {
        'claude-tmux': { type: 'claude-cli', model: 'claude-sonnet-5-5', token: 'tok-secreto' },
        'local-host': { type: 'remote', provider: 'claude-tmux' },
      },
    }

    it('shows the model of each candidate: its own, its provider default, or the target of a remote', () => {
      expect(configSummary(source).agents[0]?.models).toEqual({
        'anthropic-api': 'claude-opus-5-5',
        'claude-tmux': 'claude-sonnet-5-5',
        'local-host': 'claude-sonnet-5-5',
      })
    })

    it('lists its MCP by id, and whether each is mounted — never a URL or a token', () => {
      const agent = configSummary(source).agents[0]
      expect(agent?.mcp_servers).toEqual([
        { id: 'github', mounted: true },
        { id: 'figma', mounted: false },
      ])
      expect(agent?.actions).toEqual(['read_file', 'add_comment'])
      const json = JSON.stringify(configSummary(source))
      expect(json).not.toContain('s3cr3t')
      expect(json).not.toContain('secreto')
      expect(json).not.toContain('tok')
    })

    it('clips the prompt with its full length; the full one, for the agent asked for', () => {
      const system = `${long}\n\nPropio.`
      const clipped = configSummary(source).agents[0]?.prompt
      expect(clipped?.system_chars).toBe(system.length)
      expect(clipped?.system.length).toBeLessThan(PROMPT_PREVIEW_CHARS + 20)
      expect(clipped?.system).toEndWith('[recortado]')
      expect(clipped?.task).toBe('Refiná {{task.ref}}')
      expect(configSummary(source, { fullPromptOf: 'refiner' }).agents[0]?.prompt?.system).toBe(
        system,
      )
    })
  })
})
