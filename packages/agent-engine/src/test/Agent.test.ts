import { describe, expect, it } from 'bun:test'
import type { McpCatalogEntry } from '@ia-flow/shared'
import { Agent, promptReferencesVariable } from '../Agent.js'
import type { IBroadcast, IMcpCatalogRepository, IProviderRegistry } from '../contract.js'

const githubEntry: McpCatalogEntry = {
  id: 'github',
  name: 'GitHub',
  config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
}

function makeCatalogRepo(entries: Record<string, McpCatalogEntry>): IMcpCatalogRepository {
  return {
    list: () => Object.values(entries),
    get: (id: string) => entries[id] ?? null,
    upsert: () => {},
    deleteById: () => {},
  }
}

function makeAgent(catalogRepo?: IMcpCatalogRepository): Agent {
  const providers = {} as IProviderRegistry
  const broadcast: IBroadcast = { send: () => {} }
  return new Agent(providers, broadcast, catalogRepo)
}

describe('Agent.resolveMcpCatalog', () => {
  it('resolves catalog IDs into providerConfig.mcpServers', () => {
    const agent = makeAgent(makeCatalogRepo({ github: githubEntry }))
    const resolved = agent.resolveMcpCatalog({
      id: 'a1',
      mcpCatalogIds: ['github'],
      providerConfig: { model: 'claude-opus-4-7' },
    })
    expect(resolved).toEqual({
      model: 'claude-opus-4-7',
      mcpServers: { github: githubEntry.config },
    })
  })

  it('merges catalog entries with inline mcpServers (inline wins on key collision)', () => {
    const inlineGithubOverride = {
      command: 'custom-github-cli',
      args: [],
    }
    const myServer = { command: 'my-server', args: ['--flag'] }
    const agent = makeAgent(makeCatalogRepo({ github: githubEntry }))
    const resolved = agent.resolveMcpCatalog({
      id: 'a1',
      mcpCatalogIds: ['github'],
      providerConfig: {
        mcpServers: { myServer, github: inlineGithubOverride },
      },
    })
    expect(resolved?.mcpServers).toEqual({
      github: inlineGithubOverride,
      myServer,
    })
  })

  it('ignores nonexistent catalog IDs without throwing', () => {
    const agent = makeAgent(makeCatalogRepo({ github: githubEntry }))
    const resolved = agent.resolveMcpCatalog({
      id: 'a1',
      mcpCatalogIds: ['nonexistent'],
      providerConfig: { model: 'claude-opus-4-7' },
    })
    expect(resolved).toEqual({ model: 'claude-opus-4-7' })
    expect((resolved?.mcpServers as unknown) ?? undefined).toBeUndefined()
  })

  it('returns providerConfig untouched when mcpCatalogIds is empty', () => {
    const agent = makeAgent(makeCatalogRepo({ github: githubEntry }))
    const providerConfig = { model: 'claude-opus-4-7' }
    const resolved = agent.resolveMcpCatalog({ id: 'a1', mcpCatalogIds: [], providerConfig })
    expect(resolved).toBe(providerConfig)
  })

  it('interpolates ${VAR} placeholders in string values from Bun.env', () => {
    const prev = Bun.env.GITHUB_TOKEN
    Bun.env.GITHUB_TOKEN = 'ghp_test_123'
    try {
      const entry: McpCatalogEntry = {
        id: 'github-mcp',
        name: 'GitHub MCP',
        config: {
          type: 'http',
          url: 'https://api.githubcopilot.com/mcp/',
          authorizationToken: '${GITHUB_TOKEN}',
        },
      }
      const agent = makeAgent(makeCatalogRepo({ 'github-mcp': entry }))
      const resolved = agent.resolveMcpCatalog({
        id: 'a1',
        mcpCatalogIds: ['github-mcp'],
        providerConfig: {},
      })
      const servers = resolved?.mcpServers as Record<string, { authorizationToken: string }>
      expect(servers['github-mcp'].authorizationToken).toBe('ghp_test_123')
    } finally {
      if (prev === undefined) delete Bun.env.GITHUB_TOKEN
      else Bun.env.GITHUB_TOKEN = prev
    }
  })

  it('returns providerConfig untouched when catalog repo is absent', () => {
    const agent = makeAgent(undefined)
    const providerConfig = { mcpServers: { myServer: { command: 'x', args: [] } } }
    const resolved = agent.resolveMcpCatalog({
      id: 'a1',
      mcpCatalogIds: ['github'],
      providerConfig,
    })
    expect(resolved).toBe(providerConfig)
  })
})

describe('promptReferencesVariable', () => {
  it('matches the exact {{path}} form', () => {
    expect(promptReferencesVariable('Context:\n{{task.comments}}\n', 'task.comments')).toBe(true)
  })

  it('matches with extra whitespace inside the braces — same trim resolveVariables applies', () => {
    expect(promptReferencesVariable('{{ task.comments }}', 'task.comments')).toBe(true)
    expect(promptReferencesVariable('{{  task.comments  }}', 'task.comments')).toBe(true)
  })

  it('does not match a different variable, even a prefix/suffix of the target path', () => {
    expect(promptReferencesVariable('{{task.description}}', 'task.comments')).toBe(false)
    expect(promptReferencesVariable('{{task.comments.foo}}', 'task.comments')).toBe(false)
  })

  it('does not match plain text mentioning the path without {{ }}', () => {
    expect(promptReferencesVariable('see task.comments for context', 'task.comments')).toBe(false)
  })

  it('returns false for a prompt with no variables at all', () => {
    expect(promptReferencesVariable('No comments variable here.', 'task.comments')).toBe(false)
  })
})
