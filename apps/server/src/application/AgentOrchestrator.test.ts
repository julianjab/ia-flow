import { describe, expect, it } from 'bun:test'
import type { McpCatalogEntry } from '@ia-flow/shared'
import type { IBroadcast } from '../domain/ports/IBroadcast.js'
import type { IMcpCatalogRepository } from '../domain/ports/IMcpCatalogRepository.js'
import type { IProjectConfigRepository } from '../domain/ports/IProjectConfigRepository.js'
import type { IProviderRegistry } from '../domain/ports/IProviderRegistry.js'
import type { IRepoRepository } from '../domain/ports/IRepoRepository.js'
import type { IToolRegistry } from '../domain/ports/IToolRegistry.js'
import { AgentOrchestrator } from './AgentOrchestrator.js'

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

function makeOrchestrator(catalogRepo?: IMcpCatalogRepository): AgentOrchestrator {
  const providers = {} as IProviderRegistry
  const tools = {} as IToolRegistry
  const configRepo = {} as IProjectConfigRepository
  const repoRepo = {} as IRepoRepository
  const broadcast: IBroadcast = { send: () => {} }
  return new AgentOrchestrator(providers, tools, configRepo, repoRepo, broadcast, catalogRepo)
}

type ResolveInput = {
  id?: string
  mcpCatalogIds?: string[]
  providerConfig?: Record<string, unknown>
}
function resolve(
  orch: AgentOrchestrator,
  agentDef: ResolveInput,
): Record<string, unknown> | undefined {
  return (
    orch as unknown as {
      resolveMcpCatalog: (a: ResolveInput) => Record<string, unknown> | undefined
    }
  ).resolveMcpCatalog(agentDef)
}

describe('AgentOrchestrator.resolveMcpCatalog', () => {
  it('resolves catalog IDs into providerConfig.mcpServers', () => {
    const orch = makeOrchestrator(makeCatalogRepo({ github: githubEntry }))
    const resolved = resolve(orch, {
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
    const orch = makeOrchestrator(makeCatalogRepo({ github: githubEntry }))
    const resolved = resolve(orch, {
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
    const orch = makeOrchestrator(makeCatalogRepo({ github: githubEntry }))
    const resolved = resolve(orch, {
      id: 'a1',
      mcpCatalogIds: ['nonexistent'],
      providerConfig: { model: 'claude-opus-4-7' },
    })
    expect(resolved).toEqual({ model: 'claude-opus-4-7' })
    expect((resolved?.mcpServers as unknown) ?? undefined).toBeUndefined()
  })

  it('returns providerConfig untouched when mcpCatalogIds is empty', () => {
    const orch = makeOrchestrator(makeCatalogRepo({ github: githubEntry }))
    const providerConfig = { model: 'claude-opus-4-7' }
    const resolved = resolve(orch, { id: 'a1', mcpCatalogIds: [], providerConfig })
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
          headers: { Authorization: 'Bearer ${GITHUB_TOKEN}' },
        },
      }
      const orch = makeOrchestrator(makeCatalogRepo({ 'github-mcp': entry }))
      const resolved = resolve(orch, {
        id: 'a1',
        mcpCatalogIds: ['github-mcp'],
        providerConfig: {},
      })
      const servers = resolved?.mcpServers as Record<string, { headers: { Authorization: string } }>
      expect(servers['github-mcp'].headers.Authorization).toBe('Bearer ghp_test_123')
    } finally {
      if (prev === undefined) delete Bun.env.GITHUB_TOKEN
      else Bun.env.GITHUB_TOKEN = prev
    }
  })

  it('returns providerConfig untouched when catalog repo is absent', () => {
    const orch = makeOrchestrator(undefined)
    const providerConfig = { mcpServers: { myServer: { command: 'x', args: [] } } }
    const resolved = resolve(orch, {
      id: 'a1',
      mcpCatalogIds: ['github'],
      providerConfig,
    })
    expect(resolved).toBe(providerConfig)
  })
})
