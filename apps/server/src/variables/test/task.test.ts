import { describe, expect, it } from 'bun:test'
import type { RepoDef, Task } from '@ia-flow/shared'
import { resolveVariable } from '../index.js'
import type { ResolveContext } from '../types.js'

function makeCtx(overrides: Partial<Task> = {}, projectRepos?: RepoDef[]): ResolveContext {
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
  return { task, projectRepos, context: 'agent-prompt' }
}

describe('{{task.branch}}', () => {
  it('resolves to task/<id> using the WorkspaceManager convention', () => {
    expect(resolveVariable('task.branch', makeCtx({ id: 'ABC42' }))).toBe('task/ABC42')
  })

  it('returns empty string when task.id is missing', () => {
    expect(resolveVariable('task.branch', makeCtx({ id: undefined as unknown as string }))).toBe('')
  })

  it('prefers task.branch (linked branch de GitHub) sobre el default task/<id>', () => {
    const ctx = makeCtx({ id: 'ABC42', branch: 'feat/add-lead-invites-abc42' })
    expect(resolveVariable('task.branch', ctx)).toBe('feat/add-lead-invites-abc42')
  })
})

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

describe('{{task.repo.*}}', () => {
  const projectRepos: RepoDef[] = [
    {
      name: 'backend',
      projectId: 'p1',
      description: 'API',
      path: '/tmp/backend',
      githubOwner: 'lahaus',
      githubRepo: 'backend',
      workflow: 'worktree',
    },
    { name: 'web', projectId: 'p1', path: '/tmp/web' },
  ]

  it('resolves via sole entry of task.repos', () => {
    const ctx = makeCtx({ repos: ['backend'] }, projectRepos)
    expect(resolveVariable('task.repo', ctx)).toBe('API')
    expect(resolveVariable('task.repo.name', ctx)).toBe('backend')
    expect(resolveVariable('task.repo.path', ctx)).toBe('/tmp/backend')
    expect(resolveVariable('task.repo.github', ctx)).toBe('lahaus/backend')
    expect(resolveVariable('task.repo.workflow', ctx)).toBe('worktree')
  })

  it('resolves for a different single-repo task', () => {
    const ctx = makeCtx({ repos: ['web'] }, projectRepos)
    expect(resolveVariable('task.repo.path', ctx)).toBe('/tmp/web')
  })

  it('returns empty when task has multiple repos (épica)', () => {
    const ctx = makeCtx({ repos: ['backend', 'web'] }, projectRepos)
    expect(resolveVariable('task.repo', ctx)).toBe('')
    expect(resolveVariable('task.repo.path', ctx)).toBe('')
  })

  it('returns empty when task has zero repos (sin refinar)', () => {
    const ctx = makeCtx({ repos: [] }, projectRepos)
    expect(resolveVariable('task.repo', ctx)).toBe('')
    expect(resolveVariable('task.repo.path', ctx)).toBe('')
  })

  it('returns empty when task.repos[0] does not match any projectRepo', () => {
    const ctx = makeCtx({ repos: ['ghost'] }, projectRepos)
    expect(resolveVariable('task.repo.path', ctx)).toBe('')
  })
})
