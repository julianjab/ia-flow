import { describe, expect, it } from 'bun:test'
import type { Task } from '@ia-flow/shared'
import { mergeSourceFieldsIntoTask } from './merge-source-fields.js'

function baseTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't',
    title: 'x',
    description: '',
    type: 'technical',
    repos: [],
    status: 'Refine',
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

describe('mergeSourceFieldsIntoTask', () => {
  it('maps source-native "Status" to canonical task.status', () => {
    const out = mergeSourceFieldsIntoTask(baseTask(), { Status: 'Blocked' })
    expect(out.status).toBe('Blocked')
    expect(out.fields).toEqual({ Status: 'Blocked' })
  })

  it('still honors the canonical "status" key for callers that use it', () => {
    const out = mergeSourceFieldsIntoTask(baseTask(), { status: 'Done' })
    expect(out.status).toBe('Done')
  })

  it('maps "Task Type" → type (lowercased) so `when` conditions keep matching', () => {
    const out = mergeSourceFieldsIntoTask(baseTask({ type: 'functional' }), {
      'Task Type': 'Technical',
    })
    expect(out.type).toBe('technical')
    expect(out.fields).toEqual({ 'Task Type': 'Technical' })
  })

  it('splits comma-separated "Repos" into task.repos', () => {
    const out = mergeSourceFieldsIntoTask(baseTask(), { Repos: 'subscriptions, ims-backend' })
    expect(out.repos).toEqual(['subscriptions', 'ims-backend'])
  })

  it('preserves the raw source-field map for evalCondition fallback', () => {
    const task = baseTask({ fields: { Existing: 'v' } })
    const out = mergeSourceFieldsIntoTask(task, { Priority: 'P1' })
    expect(out.fields).toEqual({ Existing: 'v', Priority: 'P1' })
    // Priority has no canonical mapping — task.status/type/repos untouched.
    expect(out.status).toBe(task.status)
    expect(out.type).toBe(task.type)
  })
})
