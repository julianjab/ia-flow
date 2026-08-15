import { describe, expect, it } from 'bun:test'
import type { TransitionManager } from '@ia-flow/issue-sources'
import type { Task } from '@ia-flow/shared'
import {
  getPendingTask,
  registerPendingTask,
  removePendingTask,
  waitForFinish,
} from '../pending-tasks.js'

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    title: 't',
    description: '',
    type: 'functional',
    repos: [],
    status: 'Todo',
    labels: [],
    assignees: [],
    fields: {},
    ...overrides,
  } as Task
}

const noopManager = {
  setAgentWorking: async (t: Task) => t,
} as unknown as TransitionManager

describe('pending-tasks waitForFinish', () => {
  it('resolves with the final task snapshot when removePendingTask fires', async () => {
    const task = makeTask({ id: 'wait-1' })
    registerPendingTask(task.id, {
      task,
      manager: noopManager,
      broadcast: () => {},
      initialStatus: 'Todo',
    })
    const p = waitForFinish(task.id)
    expect(p).not.toBeNull()

    // Simulate complete_task mutating the task via the pending entry
    // before removing it, as the real tool does.
    const entry = getPendingTask(task.id)!
    entry.task = { ...entry.task, status: 'Done' }
    removePendingTask(task.id, { finalizedByTool: true })

    const result = await p!
    expect(result.task.status).toBe('Done')
    expect(result.finalizedByTool).toBe(true)
    expect(result.cancelled).toBe(false)
  })

  it('propagates cancelled flag from the pending entry', async () => {
    const task = makeTask({ id: 'wait-2' })
    registerPendingTask(task.id, {
      task,
      manager: noopManager,
      broadcast: () => {},
      initialStatus: 'Todo',
      cancelled: true,
    })
    const p = waitForFinish(task.id)!
    removePendingTask(task.id)
    const result = await p
    expect(result.cancelled).toBe(true)
    expect(result.finalizedByTool).toBe(false)
  })

  it('returns null when the task was never registered', () => {
    expect(waitForFinish('never-registered')).toBeNull()
  })

  it('a caller that awaits after removal still gets the resolved promise if it grabbed it first', async () => {
    const task = makeTask({ id: 'wait-3' })
    registerPendingTask(task.id, {
      task,
      manager: noopManager,
      broadcast: () => {},
      initialStatus: 'Todo',
    })
    const p = waitForFinish(task.id)!
    removePendingTask(task.id, { finalizedByTool: true })
    // waitForFinish now returns null (entry cleaned up), but the caller who
    // grabbed `p` before removal must still be able to await it.
    expect(waitForFinish(task.id)).toBeNull()
    const result = await p
    expect(result.finalizedByTool).toBe(true)
  })
})
