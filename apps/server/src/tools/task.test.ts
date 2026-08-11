import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { Task } from '@ia-flow/shared'
import { registerPendingTask, removePendingTask } from '../agents/pending-tasks.js'
import type { TransitionManager } from '../issue-managers/transition-manager.js'
import { getTool } from './index.js'

import './task.js'

// ─── Fake manager captures port calls ─────────────────────────────────────────

interface FakeCalls {
  saveOutput: Array<{ task: Task; content: string }>
  postComment: Array<{ task: Task; body: string }>
  setFields: Array<{ task: Task; fields: Record<string, string> }>
  setLabels: Array<{ task: Task; labels: string[] }>
  applyTransition: Array<{ task: Task; status: string }>
}

function makeFakeManager(calls: FakeCalls): TransitionManager {
  return {
    async applyTransition(task, status) {
      calls.applyTransition.push({ task, status })
      return { ...task, status }
    },
    async saveOutput(task, content) {
      calls.saveOutput.push({ task, content })
      return { ...task, description: content }
    },
    async setAgentWorking(task) {
      return task
    },
    async postComment(task, body) {
      calls.postComment.push({ task, body })
    },
    async setFields(task, fields) {
      calls.setFields.push({ task, fields })
      return { ...task, ...fields } as Task
    },
    async setLabels(task, labels) {
      calls.setLabels.push({ task, labels })
      return task
    },
  }
}

const TASK_ID = 'task-under-test'

function baseTask(): Task {
  return {
    id: TASK_ID,
    title: 'Sample',
    description: 'orig',
    status: 'Queue',
    type: 'functional',
    repos: [],
    created_at: '2025-01-01T00:00:00Z',
  }
}

let calls: FakeCalls
let broadcasts: object[]

beforeEach(() => {
  calls = {
    saveOutput: [],
    postComment: [],
    setFields: [],
    setLabels: [],
    applyTransition: [],
  }
  broadcasts = []
  registerPendingTask(TASK_ID, {
    task: baseTask(),
    manager: makeFakeManager(calls),
    broadcast: (msg) => broadcasts.push(msg),
    initialStatus: 'Queue',
    onFinish: 'Done',
  })
})

afterEach(() => {
  removePendingTask(TASK_ID)
})

describe('agnostic task tools route via ITransitionManager', () => {
  it('update_issue_body → manager.saveOutput', async () => {
    const tool = getTool('update_issue_body')!
    await tool.execute({ task_id: TASK_ID, body: 'new content' }, { repoPaths: {} })
    expect(calls.saveOutput).toHaveLength(1)
    expect(calls.saveOutput[0].content).toBe('new content')
    expect(broadcasts).toHaveLength(1)
  })

  it('add_task_comment → manager.postComment', async () => {
    const tool = getTool('add_task_comment')!
    await tool.execute({ task_id: TASK_ID, body: 'hello' }, { repoPaths: {} })
    expect(calls.postComment).toHaveLength(1)
    expect(calls.postComment[0].body).toBe('hello')
  })

  it('set_task_field → manager.setFields with a single-entry object', async () => {
    const tool = getTool('set_task_field')!
    await tool.execute(
      { task_id: TASK_ID, field_name: 'Task Type', value: 'Functional' },
      { repoPaths: {} },
    )
    expect(calls.setFields).toHaveLength(1)
    expect(calls.setFields[0].fields).toEqual({ 'Task Type': 'Functional' })
  })

  it('set_task_labels → manager.setLabels', async () => {
    const tool = getTool('set_task_labels')!
    await tool.execute({ task_id: TASK_ID, labels: ['bug', 'frontend'] }, { repoPaths: {} })
    expect(calls.setLabels).toHaveLength(1)
    expect(calls.setLabels[0].labels).toEqual(['bug', 'frontend'])
  })

  it('complete_task applies onFinish when the prompt did not move the task', async () => {
    const tool = getTool('complete_task')!
    await tool.execute({ task_id: TASK_ID, summary: 'done' }, { repoPaths: {} })
    expect(calls.applyTransition).toEqual([
      { task: expect.objectContaining({ status: 'Queue' }), status: 'Done' },
    ])
  })

  it('complete_task skips default onFinish when the prompt already moved the task', async () => {
    const setField = getTool('set_task_field')!
    await setField.execute(
      { task_id: TASK_ID, field_name: 'status', value: 'Blocked' },
      { repoPaths: {} },
    )
    const complete = getTool('complete_task')!
    await complete.execute({ task_id: TASK_ID, summary: 'blocked, waiting' }, { repoPaths: {} })
    expect(calls.applyTransition).toEqual([])
  })

  it('complete_task honors an explicit status override even if the prompt moved the task', async () => {
    const setField = getTool('set_task_field')!
    await setField.execute(
      { task_id: TASK_ID, field_name: 'status', value: 'Blocked' },
      { repoPaths: {} },
    )
    const complete = getTool('complete_task')!
    await complete.execute(
      { task_id: TASK_ID, summary: 'forced', status: 'Review' },
      { repoPaths: {} },
    )
    expect(calls.applyTransition).toEqual([
      { task: expect.objectContaining({ status: 'Blocked' }), status: 'Review' },
    ])
  })

  it('throws when the pending task is unknown', async () => {
    const tool = getTool('add_task_comment')!
    await expect(
      tool.execute({ task_id: 'nonexistent', body: 'x' }, { repoPaths: {} }),
    ).rejects.toThrow("No hay tarea activa con id 'nonexistent'")
  })
})
