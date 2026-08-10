import { describe, expect, it } from 'bun:test'
import type { Task } from '@ia-flow/shared'
import { resolveVariable } from './index.js'
import type { ResolveContext } from './types.js'

function makeCtx(overrides: Partial<Task> = {}): ResolveContext {
  const task: Task = {
    id: 't1',
    title: 'Sample',
    description: 'desc',
    status: 'Queue',
    type: 'functional',
    repos: [],
    created_at: '2025-01-01T00:00:00Z',
    ...overrides,
  }
  return { task, context: 'agent-prompt' }
}

describe('{{task.comments}}', () => {
  it('renders empty string when task has no comments', () => {
    expect(resolveVariable('task.comments', makeCtx())).toBe('')
  })

  it('renders one comment as [YYYY-MM-DD HH:mm]\\nbody', () => {
    const ctx = makeCtx({
      comments: [{ body: 'first comment', created_at: '2025-01-15T14:30:00Z' }],
    })
    const rendered = resolveVariable('task.comments', ctx) ?? ''
    expect(rendered).toContain('first comment')
    expect(rendered).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\]\nfirst comment$/)
  })

  it('renders multiple comments separated by a blank line', () => {
    const ctx = makeCtx({
      comments: [
        { body: 'a', created_at: '2025-01-15T14:30:00Z' },
        { body: 'b', created_at: '2025-01-16T09:12:00Z' },
      ],
    })
    const rendered = resolveVariable('task.comments', ctx) ?? ''
    const blocks = rendered.split('\n\n')
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toMatch(/\]\na$/)
    expect(blocks[1]).toMatch(/\]\nb$/)
  })

  it('keeps body-only when created_at is missing', () => {
    const ctx = makeCtx({
      comments: [{ body: 'no date' } as unknown as { body: string; created_at: string }],
    })
    expect(resolveVariable('task.comments', ctx)).toBe('no date')
  })
})
