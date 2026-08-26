import { describe, expect, it } from 'bun:test'
import type { McpCatalogEntry } from '@ia-flow/shared'
import { Agent, promptReferencesVariable, setSecretResolver } from '../Agent.js'
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
  it('resolves catalog IDs into providerConfig.mcpServers', async () => {
    const agent = makeAgent(makeCatalogRepo({ github: githubEntry }))
    const resolved = await agent.resolveMcpCatalog({
      id: 'a1',
      mcpCatalogIds: ['github'],
      providerConfig: { model: 'claude-opus-4-7' },
    })
    expect(resolved).toEqual({
      model: 'claude-opus-4-7',
      mcpServers: { github: githubEntry.config },
    })
  })

  it('merges catalog entries with inline mcpServers (inline wins on key collision)', async () => {
    const inlineGithubOverride = {
      command: 'custom-github-cli',
      args: [],
    }
    const myServer = { command: 'my-server', args: ['--flag'] }
    const agent = makeAgent(makeCatalogRepo({ github: githubEntry }))
    const resolved = await agent.resolveMcpCatalog({
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

  it('ignores nonexistent catalog IDs without throwing', async () => {
    const agent = makeAgent(makeCatalogRepo({ github: githubEntry }))
    const resolved = await agent.resolveMcpCatalog({
      id: 'a1',
      mcpCatalogIds: ['nonexistent'],
      providerConfig: { model: 'claude-opus-4-7' },
    })
    expect(resolved).toEqual({ model: 'claude-opus-4-7' })
    expect((resolved?.mcpServers as unknown) ?? undefined).toBeUndefined()
  })

  it('returns providerConfig untouched when mcpCatalogIds is empty', async () => {
    const agent = makeAgent(makeCatalogRepo({ github: githubEntry }))
    const providerConfig = { model: 'claude-opus-4-7' }
    const resolved = await agent.resolveMcpCatalog({ id: 'a1', mcpCatalogIds: [], providerConfig })
    expect(resolved).toBe(providerConfig)
  })

  it('interpolates ${VAR} placeholders in string values from Bun.env', async () => {
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
      const resolved = await agent.resolveMcpCatalog({
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

  it('resuelve ${VAR} contra el resolver del host cuando hay uno cableado', async () => {
    // El MCP oficial de GitHub recibe la credencial por `${GITHUB_TOKEN}`. Con
    // una GitHub App el token no vive en el env y rota cada hora, así que el
    // host cablea un resolver que lo pide fresco por run. Sin este hook el MCP
    // arrancaría con lo que hubiera en el env al boot — vacío, o vencido.
    const prev = Bun.env.GITHUB_TOKEN
    Bun.env.GITHUB_TOKEN = 'ghp_del_env'
    let mints = 0
    setSecretResolver(async (name) =>
      name === 'GITHUB_TOKEN' ? `ghs_rotado_${++mints}` : Bun.env[name],
    )
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
      const read = async () => {
        const resolved = await agent.resolveMcpCatalog({
          id: 'a1',
          mcpCatalogIds: ['github-mcp'],
          providerConfig: {},
        })
        const servers = resolved?.mcpServers as Record<string, { authorizationToken: string }>
        return servers['github-mcp'].authorizationToken
      }
      expect(await read()).toBe('ghs_rotado_1')
      // Y cada run pregunta de nuevo, no reusa el de la vez pasada.
      expect(await read()).toBe('ghs_rotado_2')
    } finally {
      setSecretResolver(async (name) => Bun.env[name])
      if (prev === undefined) delete Bun.env.GITHUB_TOKEN
      else Bun.env.GITHUB_TOKEN = prev
    }
  })

  it('returns providerConfig untouched when catalog repo is absent', async () => {
    const agent = makeAgent(undefined)
    const providerConfig = { mcpServers: { myServer: { command: 'x', args: [] } } }
    const resolved = await agent.resolveMcpCatalog({
      id: 'a1',
      mcpCatalogIds: ['github'],
      providerConfig,
    })
    expect(resolved).toBe(providerConfig)
  })
})

describe('promptReferencesVariable', () => {
  it('matches the exact {{path}} form', async () => {
    expect(promptReferencesVariable('Context:\n{{task.comments}}\n', 'task.comments')).toBe(true)
  })

  it('matches with extra whitespace inside the braces — same trim resolveVariables applies', async () => {
    expect(promptReferencesVariable('{{ task.comments }}', 'task.comments')).toBe(true)
    expect(promptReferencesVariable('{{  task.comments  }}', 'task.comments')).toBe(true)
  })

  it('does not match a different variable, even a prefix/suffix of the target path', async () => {
    expect(promptReferencesVariable('{{task.description}}', 'task.comments')).toBe(false)
    expect(promptReferencesVariable('{{task.comments.foo}}', 'task.comments')).toBe(false)
  })

  it('does not match plain text mentioning the path without {{ }}', async () => {
    expect(promptReferencesVariable('see task.comments for context', 'task.comments')).toBe(false)
  })

  it('returns false for a prompt with no variables at all', async () => {
    expect(promptReferencesVariable('No comments variable here.', 'task.comments')).toBe(false)
  })
})
