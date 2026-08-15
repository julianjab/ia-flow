import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { registerPendingTask, removePendingTask } from '@ia-flow/agent-engine'
import { type TransitionManager, mergeSourceFieldsIntoTask } from '@ia-flow/issue-sources'
import type { Task } from '@ia-flow/shared'
import { getTool } from '../../engine.js'

import '../task.js'

// ─── Fake manager captures port calls ─────────────────────────────────────────

interface FakeCalls {
  saveOutput: Array<{ task: Task; content: string }>
  postComment: Array<{ task: Task; body: string }>
  postError: Array<{ task: Task; error: string }>
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
    async postError(task, error) {
      calls.postError.push({ task, error })
    },
    async setFields(task, fields) {
      calls.setFields.push({ task, fields })
      return mergeSourceFieldsIntoTask(task, fields)
    },
    async setLabels(task, labels) {
      calls.setLabels.push({ task, labels })
      return task
    },
    async getCurrentStatus(task) {
      return task.status
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
    postError: [],
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

  it('add_task_comment renders structured markdown via manager.postComment', async () => {
    const tool = getTool('add_task_comment')!
    await tool.execute(
      {
        task_id: TASK_ID,
        headline: 'checkpoint',
        what_did: ['tocó A', 'tocó B'],
        validations: ['bun test ok'],
      },
      { repoPaths: {} },
    )
    expect(calls.postComment).toHaveLength(1)
    const body = calls.postComment[0].body
    expect(body).toMatch(/^# .+· checkpoint$/m)
    expect(body).toContain('**Qué hice**')
    expect(body).toContain('- tocó A')
    expect(body).toContain('**Validaciones**')
  })

  it('add_task_comment legacy `body` maps into what_did', async () => {
    const tool = getTool('add_task_comment')!
    await tool.execute({ task_id: TASK_ID, body: 'raw markdown' }, { repoPaths: {} })
    expect(calls.postComment[0].body).toContain('- raw markdown')
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

  it('complete_task posts a structured comment and applies onFinish', async () => {
    const tool = getTool('complete_task')!
    await tool.execute(
      {
        task_id: TASK_ID,
        what_did: ['tocó archivo A', 'abrió PR #42'],
        validations: ['bun test ok', 'biome check ok'],
      },
      { repoPaths: {} },
    )
    expect(calls.applyTransition).toEqual([
      { task: expect.objectContaining({ status: 'Queue' }), status: 'Done' },
    ])
    expect(calls.postComment).toHaveLength(1)
    const body = calls.postComment[0].body
    expect(body).toContain('**Qué hice**')
    expect(body).toContain('- tocó archivo A')
    expect(body).toContain('**Validaciones**')
    expect(body).toContain('- bun test ok')
  })

  it('complete_task legacy `summary` maps into what_did', async () => {
    const tool = getTool('complete_task')!
    await tool.execute(
      { task_id: TASK_ID, summary: 'legacy caller', validations: [] },
      { repoPaths: {} },
    )
    expect(calls.postComment[0].body).toContain('- legacy caller')
  })

  it('complete_task skips default onFinish when the prompt already moved the task', async () => {
    const setField = getTool('set_task_field')!
    await setField.execute(
      { task_id: TASK_ID, field_name: 'status', value: 'Blocked' },
      { repoPaths: {} },
    )
    const complete = getTool('complete_task')!
    await complete.execute(
      { task_id: TASK_ID, what_did: ['x'], validations: ['y'] },
      { repoPaths: {} },
    )
    expect(calls.applyTransition).toEqual([])
  })

  it('complete_task skips default onFinish when the prompt used the source-native field name (e.g. "Status")', async () => {
    const setField = getTool('set_task_field')!
    await setField.execute(
      { task_id: TASK_ID, field_name: 'Status', value: 'Blocked' },
      { repoPaths: {} },
    )
    const complete = getTool('complete_task')!
    await complete.execute(
      { task_id: TASK_ID, what_did: ['x'], validations: ['y'] },
      { repoPaths: {} },
    )
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
      { task_id: TASK_ID, what_did: ['x'], validations: ['y'], status: 'Review' },
      { repoPaths: {} },
    )
    expect(calls.applyTransition).toEqual([
      { task: expect.objectContaining({ status: 'Blocked' }), status: 'Review' },
    ])
  })

  it('fail_task posts a structured error comment AND persists error state via postError', async () => {
    const tool = getTool('fail_task')!
    await tool.execute(
      {
        task_id: TASK_ID,
        what_tried: ['probé A', 'probé B'],
        where_failed: 'B falla al compilar',
        validations: ['tsc con error TS2345'],
      },
      { repoPaths: {} },
    )
    expect(calls.postComment).toHaveLength(1)
    const body = calls.postComment[0].body
    expect(body).toContain('❌ falló')
    expect(body).toContain('**Qué intenté**')
    expect(body).toContain('- probé A')
    expect(body).toContain('**Dónde falló**')
    expect(body).toContain('B falla al compilar')

    // Ambos canales: postComment (timeline) + postError (state/banner).
    expect(calls.postError).toHaveLength(1)
    expect(calls.postError[0].error).toBe('B falla al compilar')
  })

  it('throws when the pending task is unknown', async () => {
    const tool = getTool('add_task_comment')!
    await expect(
      tool.execute({ task_id: 'nonexistent', body: 'x' }, { repoPaths: {} }),
    ).rejects.toThrow("No hay tarea activa con id 'nonexistent'")
  })
})
