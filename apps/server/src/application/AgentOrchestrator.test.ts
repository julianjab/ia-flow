import { describe, expect, it, mock } from 'bun:test'
import type { McpCatalogEntry, Task } from '@ia-flow/shared'
import { UpstreamAbortError } from '../domain/errors.js'
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
import {
  type ShellResult,
  type ShellRunner,
  WorkspaceManager,
  worktreePathFor,
} from './WorkspaceManager.js'

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
  function makeTask(): Task {
    return {
      id: 'task-abort-1',
      title: 't',
      description: '',
      type: 'technical',
      repos: [],
      status: 'InProgress',
      projectId: 'p1',
    } as unknown as Task
  }

  function makeDeps(providerError: Error) {
    const provider: IAgentProvider = {
      id: 'anthropic-api',
      kind: 'sync',
      name: 'test',
      description: '',
      run: async (_: ProviderInput) => {
        throw providerError
      },
    }
    const providers: IProviderRegistry = {
      get: (id: string) => (id === 'anthropic-api' ? provider : undefined),
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
    const postError = mock(async () => {})
    const manager: ITransitionManager = {
      applyTransition: async (t: Task) => t,
      saveOutput: async (t: Task) => t,
      setAgentWorking,
      postError,
      getCurrentStatus: async () => 'InProgress',
    } as unknown as ITransitionManager

    const update = mock(() => {})
    const executionLogRepo: IExecutionLogRepository = {
      insert: () => {},
      update,
      list: () => [],
      listActive: () => [],
      getById: () => null,
      sweepOrphaned: () => 0,
    }

    const orch = new AgentOrchestrator(
      providers,
      {} as IToolRegistry,
      configRepo,
      repoRepo,
      { send: () => {} } as IBroadcast,
      undefined,
      executionLogRepo,
    )

    return { orch, manager, update, setAgentWorking }
  }

  // Regression: an AbortError thrown by the provider used to be swallowed by a
  // ReferenceError inside the catch block (`controller` was declared inside the
  // sibling try). That left execution_logs rows open forever and the task with
  // agent-working=true. This test locks the recovery path in place.
  it('marks execution_logs as cancelled and clears working on UpstreamAbortError', async () => {
    const err = new UpstreamAbortError(
      'Anthropic API upstream abort after 276000ms: The operation timed out',
    )
    const { orch, manager, update, setAgentWorking } = makeDeps(err)

    await orch.runAgent(makeTask(), manager)

    expect(update).toHaveBeenCalled()
    const patch = update.mock.calls.at(-1)?.[1] as {
      finishedAt?: string
      outcome?: string
      errorMsg?: string
    }
    expect(patch.outcome).toBe('cancelled')
    expect(patch.finishedAt).toBeTruthy()
    expect(patch.errorMsg ?? '').toContain('upstream-abort')

    const clearedWorking = setAgentWorking.mock.calls.some((c) => c[1] === false)
    expect(clearedWorking).toBe(true)
  })

  // A plain AbortError (name === 'AbortError') that is NOT an UpstreamAbortError
  // must go to the generic error path — outcome='error' — instead of being
  // silently treated as an operator cancel. Guards against the old
  // `err.name === 'AbortError'` heuristic sneaking back in.
  it('treats a plain AbortError as a real error, not an upstream-abort', async () => {
    const err = new Error('operation aborted')
    err.name = 'AbortError'
    const { orch, manager, update } = makeDeps(err)

    // Normal error path rethrows once execution_logs is updated.
    await expect(orch.runAgent(makeTask(), manager)).rejects.toThrow('operation aborted')

    const patch = update.mock.calls.at(-1)?.[1] as { outcome?: string; errorMsg?: string }
    expect(patch.outcome).toBe('error')
    expect(patch.errorMsg ?? '').not.toContain('upstream-abort')
  })
})

// ─── WorkspaceManager integration ────────────────────────────────────────
//
// End-to-end (in-process): a real `WorkspaceManager` wired with a stub
// `ShellRunner` so we can exercise `acquireTask` / `getOrCreateWorktree` /
// `resolveScopes` / `releaseTask` without touching disk or spawning git.
// The provider is a capturing stub that records what the orchestrator
// forwarded so we can assert the ToolContext handshake (repoPaths swap +
// writePaths propagation).

const REPO = '/repos/demo'

/**
 * Minimal `ShellRunner` that answers with successful exits for the git
 * commands the WorkspaceManager issues during a create-path
 * `getOrCreateWorktree`:
 *   • `git fetch origin` → ok
 *   • `git worktree list --porcelain` → main only (no reuse)
 *   • `git rev-parse --verify …` → exit 1 (branch doesn't pre-exist)
 *   • `git worktree add -b <branch> <path> origin/main` → ok
 * Any other command falls through to a benign `ok()` so the test isn't
 * brittle to future WorkspaceManager evolutions.
 */
function okShell(): ShellRunner {
  return {
    async run(args: string[]): Promise<ShellResult> {
      if (args[0] === 'git' && args[1] === 'worktree' && args[2] === 'list') {
        // Only the main worktree exists — force the create path.
        return { stdout: `worktree ${REPO}\n`, stderr: '', exitCode: 0 }
      }
      if (args[0] === 'git' && args[1] === 'rev-parse') {
        // Branch doesn't pre-exist → `git worktree add -b` path.
        return { stdout: '', stderr: '', exitCode: 1 }
      }
      return { stdout: '', stderr: '', exitCode: 0 }
    },
  }
}

interface WsDeps {
  agentTools?: string[]
  workspaceManager: WorkspaceManager
  captureInput?: (input: ProviderInput) => void
}

function makeWsDeps(opts: WsDeps): { orch: AgentOrchestrator; manager: ITransitionManager } {
  const provider: IAgentProvider = {
    id: 'anthropic-api',
    kind: 'sync',
    name: 'test',
    description: '',
    run: async (input: ProviderInput) => {
      opts.captureInput?.(input)
      return { content: 'ok', mode: 'api' }
    },
  }
  const providers: IProviderRegistry = {
    get: (id: string) => (id === 'anthropic-api' ? provider : undefined),
  } as unknown as IProviderRegistry

  const configRepo: IProjectConfigRepository = {
    getConfig: async () => ({
      agents: [
        {
          id: 'implementer',
          provider: 'anthropic-api',
          prompt: 'x',
          tools: opts.agentTools ?? [],
        },
      ],
      statuses: [{ name: 'InProgress', agents: [{ agent: 'implementer' }] }],
    }),
  } as unknown as IProjectConfigRepository

  const repoRepo: IRepoRepository = {
    list: () => [{ name: 'demo', path: REPO }],
    listByProject: () => [{ name: 'demo', path: REPO }],
  } as unknown as IRepoRepository

  const manager: ITransitionManager = {
    applyTransition: async (t: Task) => t,
    saveOutput: async (t: Task) => t,
    setAgentWorking: async (t: Task, _working: boolean) => t,
    postError: async () => {},
    getCurrentStatus: async (t: Task) => t.status,
  } as unknown as ITransitionManager

  const orch = new AgentOrchestrator(
    providers,
    {} as IToolRegistry,
    configRepo,
    repoRepo,
    { send: () => {} } as IBroadcast,
    undefined, // mcpCatalogRepo
    undefined, // executionLogRepo
    opts.workspaceManager,
  )
  return { orch, manager }
}

function makeWsTask(id: string): Task {
  return {
    id,
    title: 'ws',
    description: '',
    type: 'technical',
    repos: ['demo'],
    status: 'InProgress',
    projectId: 'p1',
  } as unknown as Task
}

describe('AgentOrchestrator — WorkspaceManager integration', () => {
  // Unique base per describe run so parallel tests never share a #taskLocks
  // key on the same in-memory WorkspaceManager instance (each `it` builds
  // its own manager anyway, but keeping the base distinct also guards
  // against filesystem existsSync races if a future refactor turns those
  // paths real).
  const BASE = `/tmp/ia-flow-integration-${Date.now()}`

  it('read-only agent → primary repoPath stays the base repo, writePaths is empty', async () => {
    const wsm = new WorkspaceManager(okShell(), { worktreeBase: BASE })
    let captured: ProviderInput | undefined
    const { orch, manager } = makeWsDeps({
      agentTools: ['read_file'],
      workspaceManager: wsm,
      captureInput: (inp) => {
        captured = inp
      },
    })

    await orch.runAgent(makeWsTask('PVTI_ws_read'), manager)

    expect(captured).toBeDefined()
    // No worktree materialized (read-only), so resolveScopes returns the base
    // repo path as the read root and no write scope.
    expect(captured!.repoPaths.demo).toBe(REPO)
    expect(captured!.writePaths ?? []).toEqual([])
  })

  it('write agent → primary repoPath is swapped to the worktree, writePaths mirrors it', async () => {
    const wsm = new WorkspaceManager(okShell(), { worktreeBase: BASE })
    let captured: ProviderInput | undefined
    const { orch, manager } = makeWsDeps({
      agentTools: ['write_file'],
      workspaceManager: wsm,
      captureInput: (inp) => {
        captured = inp
      },
    })

    const TASK_ID = 'PVTI_ws_write'
    await orch.runAgent(makeWsTask(TASK_ID), manager)

    const wt = worktreePathFor(REPO, TASK_ID, BASE)
    expect(captured!.repoPaths.demo).toBe(wt)
    expect(captured!.writePaths).toEqual([wt])
  })

  it('per-task mutex: a second runAgent while the lock is held throws "task <id> ya está corriendo"', async () => {
    const wsm = new WorkspaceManager(okShell(), { worktreeBase: BASE })
    const TASK_ID = 'PVTI_ws_locked'

    // Simulate a run already in-flight by grabbing the lock outside the
    // orchestrator — same primitive the orchestrator uses internally.
    wsm.acquireTask(TASK_ID, REPO)
    try {
      const { orch, manager } = makeWsDeps({
        agentTools: ['read_file'],
        workspaceManager: wsm,
      })
      await expect(orch.runAgent(makeWsTask(TASK_ID), manager)).rejects.toThrow(
        `task ${TASK_ID} ya está corriendo`,
      )
    } finally {
      // Never leak the lock — otherwise a follow-up test on the same manager
      // instance would inherit the "locked" state.
      wsm.releaseTask(TASK_ID)
    }
  })

  it('releases the lock in `finally` so a follow-up runAgent on the same task succeeds', async () => {
    const wsm = new WorkspaceManager(okShell(), { worktreeBase: BASE })
    const TASK_ID = 'PVTI_ws_sequential'
    const { orch, manager } = makeWsDeps({
      agentTools: ['read_file'],
      workspaceManager: wsm,
    })

    // First run completes → releaseTask fires in `finally`.
    await orch.runAgent(makeWsTask(TASK_ID), manager)
    // Second run must not throw "ya está corriendo".
    await orch.runAgent(makeWsTask(TASK_ID), manager)
  })
})
