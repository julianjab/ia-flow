import { describe, expect, it, mock } from 'bun:test'
import type { IIssueManager, ITaskSource, IssueItem } from '@ia-flow/issue-sources'
import type { ProjectConfig } from '@ia-flow/shared'
import type { AgentOrchestrator } from '../AgentOrchestrator.js'
import { TaskDispatcher } from '../TaskDispatcher.js'
import type { IBroadcast, IProjectConfigRepository } from '../contract.js'

function makeItem(over: Partial<IssueItem> = {}): IssueItem {
  return {
    id: 'task-1',
    title: 'T',
    description: '',
    status: 'Refine',
    type: 'functional',
    repos: [],
    projectId: 'p1',
    ...over,
  }
}

function makeConfig(allowBlocked: boolean): ProjectConfig {
  return {
    // `allowBlocked` vive en el agente, no en el status — el dispatcher
    // gatea contra el agente que `selectAgent` realmente va a correr
    // (mismos criterios: project/repo/status/when), no contra una fila de
    // `statuses` separada. `statuses` queda de config para el front.
    agents: [
      {
        id: 'ia-flow-refiner',
        provider: 'anthropic-api',
        prompt: 'x',
        statusName: 'Refine',
        allowBlocked,
      },
    ],
  } as ProjectConfig
}

function makeConfigWithPrompt(prompt: string): ProjectConfig {
  return {
    agents: [{ id: 'ia-flow-refiner', provider: 'anthropic-api', prompt, statusName: 'Refine' }],
  } as ProjectConfig
}

function makeDeps(config: ProjectConfig | null) {
  const runAgent = mock(async (_task: unknown, _manager: ITaskSource) => true)
  const orchestrator = { runAgent } as unknown as AgentOrchestrator
  const broadcast: IBroadcast = { send: () => {} }
  const configRepo: IProjectConfigRepository = {
    getConfig: async () => config,
    saveConfig: async () => {},
  } as unknown as IProjectConfigRepository
  return { orchestrator, broadcast, configRepo, runAgent }
}

function makeManager(over: Partial<IIssueManager> = {}): IIssueManager {
  const transitionManager: ITaskSource = {
    applyTransition: async (t) => t,
    saveOutput: async (t) => t,
    setAgentWorking: async (t) => t,
  }
  return {
    start: () => ({ dispose: () => {} }),
    getTransitionManager: () => transitionManager,
    ...over,
  }
}

describe('TaskDispatcher blocker gate', () => {
  it('skips items with open blockers when allowBlocked=false', async () => {
    const { orchestrator, broadcast, configRepo, runAgent } = makeDeps(makeConfig(false))
    const getBlockers = mock(async () => [{ id: 'other-task', ref: '#42 pending' }])
    const manager = makeManager({ getBlockers })
    const dispatcher = new TaskDispatcher(orchestrator, broadcast, configRepo)

    await dispatcher.dispatch(makeItem(), manager)

    expect(getBlockers).toHaveBeenCalled()
    expect(runAgent).not.toHaveBeenCalled()
  })

  it('runs the agent when allowBlocked=true even with open blockers', async () => {
    const { orchestrator, broadcast, configRepo, runAgent } = makeDeps(makeConfig(true))
    const getBlockers = mock(async () => [{ id: 'other-task' }])
    const manager = makeManager({ getBlockers })
    const dispatcher = new TaskDispatcher(orchestrator, broadcast, configRepo)

    await dispatcher.dispatch(makeItem(), manager)

    expect(getBlockers).not.toHaveBeenCalled()
    expect(runAgent).toHaveBeenCalledTimes(1)
  })

  it('runs the agent when getBlockers returns []', async () => {
    const { orchestrator, broadcast, configRepo, runAgent } = makeDeps(makeConfig(false))
    const manager = makeManager({ getBlockers: async () => [] })
    const dispatcher = new TaskDispatcher(orchestrator, broadcast, configRepo)

    await dispatcher.dispatch(makeItem(), manager)

    expect(runAgent).toHaveBeenCalledTimes(1)
  })

  it('dispatches when the manager does not implement getBlockers', async () => {
    const { orchestrator, broadcast, configRepo, runAgent } = makeDeps(makeConfig(false))
    const manager = makeManager() // no getBlockers
    const dispatcher = new TaskDispatcher(orchestrator, broadcast, configRepo)

    await dispatcher.dispatch(makeItem(), manager)

    expect(runAgent).toHaveBeenCalledTimes(1)
  })

  it('skips when no agent matches the item status — no `statuses` row needed to reject it', async () => {
    const config: ProjectConfig = {
      agents: [
        { id: 'ia-flow-refiner', provider: 'anthropic-api', prompt: 'x', statusName: 'Build' },
      ],
    } as ProjectConfig
    const { orchestrator, broadcast, configRepo, runAgent } = makeDeps(config)
    const manager = makeManager()
    const dispatcher = new TaskDispatcher(orchestrator, broadcast, configRepo)

    await dispatcher.dispatch(makeItem({ status: 'Refine' }), manager)

    expect(runAgent).not.toHaveBeenCalled()
  })
})

describe('TaskDispatcher comments', () => {
  // NOTE: TaskDispatcher no longer calls markCommentsUsed itself — it loads
  // comments and forwards the IIssueManager's markCommentsUsed onto the
  // per-item TaskSource it hands to Agent.run, which does the actual
  // gate-and-mark AFTER the provider consumes the prompt (using the run's
  // real agentDef, not the one selectAgent matched here pre-dispatch). See
  // agent-engine's Agent.ts. These tests cover only the forwarding.
  it('loads comments and forwards markCommentsUsed onto the TaskSource passed to runAgent', async () => {
    const { orchestrator, broadcast, configRepo, runAgent } = makeDeps(
      makeConfigWithPrompt('Context:\n{{task.comments}}\n'),
    )
    const loaded = [{ id: 'c1', body: 'please retry', created_at: '2024-01-01T00:00:00Z' }]
    const loadComments = mock(async () => loaded)
    const markCommentsUsed = mock(async () => {})
    const manager = makeManager({ loadComments, markCommentsUsed })
    const dispatcher = new TaskDispatcher(orchestrator, broadcast, configRepo)

    await dispatcher.dispatch(makeItem(), manager)

    expect(loadComments).toHaveBeenCalledTimes(1)
    expect(markCommentsUsed).not.toHaveBeenCalled() // not TaskDispatcher's job anymore

    const transitionsPassedToRunAgent = runAgent.mock.calls[0]?.[1]
    expect(typeof transitionsPassedToRunAgent?.markCommentsUsed).toBe('function')
    await transitionsPassedToRunAgent?.markCommentsUsed?.(loaded)
    expect(markCommentsUsed).toHaveBeenCalledWith(loaded)
  })

  it('does not forward markCommentsUsed when the manager does not implement it', async () => {
    const { orchestrator, broadcast, configRepo, runAgent } = makeDeps(
      makeConfigWithPrompt('{{task.comments}}'),
    )
    const loadComments = mock(async () => [
      { id: 'c1', body: 'x', created_at: '2024-01-01T00:00:00Z' },
    ])
    const manager = makeManager({ loadComments }) // no markCommentsUsed
    const dispatcher = new TaskDispatcher(orchestrator, broadcast, configRepo)

    await dispatcher.dispatch(makeItem(), manager)

    const transitionsPassedToRunAgent = runAgent.mock.calls[0]?.[1]
    expect(transitionsPassedToRunAgent?.markCommentsUsed).toBeUndefined()
  })
})
