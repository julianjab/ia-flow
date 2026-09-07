import { describe, expect, it, mock } from 'bun:test'
import type { IAgentProvider, ProviderInput } from '@ia-flow/ai-providers'
import type { ITaskSource } from '@ia-flow/issue-sources'
import type { PullRequestRef, Task } from '@ia-flow/shared'
import { AgentOrchestrator } from '../AgentOrchestrator.js'
import type {
  IBroadcast,
  IExecutionLogRepository,
  IProjectConfigRepository,
  IProviderRegistry,
  IRepoRepository,
  PrDiffPort,
} from '../contract.js'

// `{{task.pr.diff}}` es la única variable de PR que paga un request propio:
// estos tests fijan el gate (promptReferencesVariable) y la resolución de
// owner/repo/number contra el primer PR abierto de la task.

const openPr: PullRequestRef = {
  number: 42,
  url: 'https://github.com/org/backend/pull/42',
  nodeId: 'PR_1',
  state: 'open',
  isDraft: false,
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-pr-1',
    title: 't',
    description: '',
    type: 'technical',
    repos: ['backend'],
    status: 'InProgress',
    projectId: 'p1',
    created_at: '2025-01-01T00:00:00Z',
    pullRequests: [openPr],
    ...overrides,
  } as Task
}

function makeDeps(prompt: string, fetchPrDiff: PrDiffPort) {
  const provider: IAgentProvider = {
    id: 'anthropic-api',
    kind: 'sync',
    name: 'test',
    description: '',
    run: async (_: ProviderInput) => ({ content: 'listo', mode: 'api' as const }),
  }
  const providers: IProviderRegistry = {
    get: (id: string) => (id === 'anthropic-api' ? provider : undefined),
    list: () => [provider],
  } as unknown as IProviderRegistry

  const configRepo: IProjectConfigRepository = {
    getConfig: async () => ({
      agents: [{ id: 'reviewer', provider: 'anthropic-api', prompt, tools: [] }],
      statuses: [{ name: 'InProgress' }],
    }),
  } as unknown as IProjectConfigRepository

  const repoRepo: IRepoRepository = {
    list: () => [],
    listByProject: () => [
      { name: 'backend', projectId: 'p1', githubOwner: 'org', githubRepo: 'backend' },
    ],
  } as unknown as IRepoRepository

  const manager: ITaskSource = {
    applyTransition: async (t: Task) => t,
    saveOutput: async (t: Task) => t,
    setAgentWorking: async (t: Task) => t,
    postComment: async () => {},
    getCurrentStatus: async () => 'InProgress',
  } as unknown as ITaskSource

  const executionLogRepo: IExecutionLogRepository = {
    insert: () => {},
    update: () => {},
    list: () => [],
    listActive: () => [],
    getById: () => null,
    sweepOrphaned: () => [],
    listDistinctSources: () => [],
    listLatestByTask: () => [],
    listLastOutputsByAgent: () => [],
  }

  const orch = new AgentOrchestrator(
    providers,
    configRepo,
    repoRepo,
    { send: () => {} } as IBroadcast,
    undefined,
    executionLogRepo,
    undefined,
    undefined,
    undefined,
    () => undefined, // resolveVariable — no nos interesa el prompt resuelto en estos tests
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    fetchPrDiff,
  )

  return { orch, manager }
}

describe('PrDiffPort — cuándo se llama', () => {
  it('se llama con owner/repo/number del primer PR abierto cuando el prompt referencia {{task.pr.diff}}', async () => {
    const fetchPrDiff = mock((_params: { owner: string; repo: string; number: number }) =>
      Promise.resolve('diff --git a/x b/x'),
    )
    const { orch, manager } = makeDeps('revisá esto: {{task.pr.diff}}', fetchPrDiff)

    await orch.runAgent(makeTask(), manager, 'reviewer')

    expect(fetchPrDiff).toHaveBeenCalledTimes(1)
    expect(fetchPrDiff.mock.calls[0]?.[0]).toEqual({ owner: 'org', repo: 'backend', number: 42 })
  })

  it('NO se llama si el prompt no referencia {{task.pr.diff}}', async () => {
    const fetchPrDiff = mock(async () => 'diff --git a/x b/x')
    const { orch, manager } = makeDeps('sólo {{task.pr.number}}', fetchPrDiff)

    await orch.runAgent(makeTask(), manager, 'reviewer')

    expect(fetchPrDiff).not.toHaveBeenCalled()
  })

  it('NO se llama sin PR abierto, aunque el prompt referencie la variable', async () => {
    const fetchPrDiff = mock(async () => 'diff --git a/x b/x')
    const { orch, manager } = makeDeps('{{task.pr.diff}}', fetchPrDiff)

    await orch.runAgent(makeTask({ pullRequests: [] }), manager, 'reviewer')

    expect(fetchPrDiff).not.toHaveBeenCalled()
  })

  it('un fallo de fetchPrDiff no tumba el run — la variable queda vacía', async () => {
    const fetchPrDiff = mock(async () => {
      throw new Error('GitHub caído')
    })
    const { orch, manager } = makeDeps('{{task.pr.diff}}', fetchPrDiff)

    const outcome = await orch.runAgent(makeTask(), manager, 'reviewer')

    expect(fetchPrDiff).toHaveBeenCalledTimes(1)
    expect(outcome).not.toBe('skipped')
  })
})
