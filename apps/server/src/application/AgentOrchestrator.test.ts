import { describe, expect, it, mock } from 'bun:test'
import type { McpCatalogEntry, Task } from '@ia-flow/shared'
import type { IAgentProvider, ProviderInput } from '../domain/ports/IAgentProvider.js'
import type { IBroadcast } from '../domain/ports/IBroadcast.js'
import type { IExecutionLogRepository } from '../domain/ports/IExecutionLogRepository.js'
import type { IMcpCatalogRepository } from '../domain/ports/IMcpCatalogRepository.js'
import type { IProjectConfigRepository } from '../domain/ports/IProjectConfigRepository.js'
import type { IProviderRegistry } from '../domain/ports/IProviderRegistry.js'
import type { IRepoRepository } from '../domain/ports/IRepoRepository.js'
import type { IToolRegistry } from '../domain/ports/IToolRegistry.js'
import type { ITransitionManager } from '../domain/ports/ITransitionManager.js'
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
          authorizationToken: '${GITHUB_TOKEN}',
        },
      }
      const orch = makeOrchestrator(makeCatalogRepo({ 'github-mcp': entry }))
      const resolved = resolve(orch, {
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

describe('AgentOrchestrator.runAgent — upstream abort handling', () => {
  // Regression: an AbortError thrown by the provider used to be swallowed by a
  // ReferenceError inside the catch block (`controller` was declared inside the
  // sibling try). That left execution_logs rows open forever and the task with
  // agent-working=true. This test locks the recovery path in place.
  it('marks execution_logs as cancelled and clears working when provider throws AbortError', async () => {
    const task: Task = {
      id: 'task-abort-1',
      title: 't',
      description: '',
      type: 'technical',
      repos: [],
      status: 'InProgress',
      projectId: 'p1',
    } as unknown as Task

    const throwingProvider: IAgentProvider = {
      id: 'anthropic-api',
      kind: 'sync',
      name: 'test',
      description: '',
      run: async (_: ProviderInput) => {
        const err = new Error(
          'Anthropic API upstream abort after 276000ms: The operation timed out',
        )
        err.name = 'AbortError'
        throw err
      },
    }
    const providers: IProviderRegistry = {
      get: (id: string) => (id === 'anthropic-api' ? throwingProvider : undefined),
    } as unknown as IProviderRegistry

    const configRepo: IProjectConfigRepository = {
      getConfig: async () => ({
        agents: [{ id: 'implementer', provider: 'anthropic-api', prompt: 'x', tools: [] }],
        statuses: [{ name: 'InProgress', agents: [{ agent: 'implementer' }] }],
      }),
    } as unknown as IProjectConfigRepository

    const repoRepo: IRepoRepository = {
      list: () => [],
      listByProject: () => [],
    } as unknown as IRepoRepository

    const setAgentWorking = mock(async (t: Task) => t)
    const manager: ITransitionManager = {
      applyTransition: async (t: Task) => t,
      saveOutput: async (t: Task) => t,
      setAgentWorking,
      getCurrentStatus: async () => 'InProgress',
    } as unknown as ITransitionManager

    const update = mock(() => {})
    const insert = mock(() => {})
    const executionLogRepo: IExecutionLogRepository = {
      insert,
      update,
      list: () => [],
      getById: () => null,
      sweepOrphaned: () => 0,
    }

    const broadcast: IBroadcast = { send: () => {} }
    const orch = new AgentOrchestrator(
      providers,
      {} as IToolRegistry,
      configRepo,
      repoRepo,
      broadcast,
      undefined,
      executionLogRepo,
    )

    await orch.runAgent(task, manager)

    // The exec log row must be closed with outcome=cancelled and an
    // errorMsg tagged upstream-abort so the operator can distinguish it from
    // a real dispatch failure.
    expect(update).toHaveBeenCalled()
    const patch = update.mock.calls.at(-1)?.[1] as {
      finishedAt?: string
      outcome?: string
      errorMsg?: string
    }
    expect(patch.outcome).toBe('cancelled')
    expect(patch.finishedAt).toBeTruthy()
    expect(patch.errorMsg ?? '').toContain('upstream-abort')

    // Working flag must be cleared so the dispatcher will pick the task up
    // again — the whole point of not leaving it stuck.
    const clearedWorking = setAgentWorking.mock.calls.some((c) => c[1] === false)
    expect(clearedWorking).toBe(true)
  })
})
