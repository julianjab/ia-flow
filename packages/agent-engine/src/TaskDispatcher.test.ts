import { describe, expect, it, mock } from 'bun:test'
import type { IIssueManager, ITransitionManager, IssueItem } from '@ia-flow/issue-sources'
import type { ProjectConfig } from '@ia-flow/shared'
import type { AgentOrchestrator } from './AgentOrchestrator.js'
import { TaskDispatcher } from './TaskDispatcher.js'
import type { IBroadcast, IProjectConfigRepository } from './contract.js'

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
    statuses: [
      {
        name: 'Refine',
        agents: [{ agent: 'ia-flow-refiner' }],
        allowBlocked,
      },
    ],
  } as ProjectConfig
}

function makeDeps(config: ProjectConfig | null) {
  const runAgent = mock(async () => true)
  const orchestrator = { runAgent } as unknown as AgentOrchestrator
  const broadcast: IBroadcast = { send: () => {} }
  const configRepo: IProjectConfigRepository = {
    getConfig: async () => config,
    saveConfig: async () => {},
  } as unknown as IProjectConfigRepository
  return { orchestrator, broadcast, configRepo, runAgent }
}

function makeManager(over: Partial<IIssueManager> = {}): IIssueManager {
  const transitionManager: ITransitionManager = {
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
})
