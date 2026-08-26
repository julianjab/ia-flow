import { afterEach, beforeAll, describe, expect, it } from 'bun:test'
import type { Task } from '@ia-flow/shared'
import type { ProjectMeta } from '../api/project.js'
import { GitHubTaskSource } from '../task-source.js'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const META: ProjectMeta = {
  projectId: 'PVT_1',
  owner: 'acme',
  fields: {
    Status: {
      id: 'f_status',
      options: [
        { id: 'opt_done', name: 'Done' },
        { id: 'opt_queue', name: 'Queue' },
      ],
    },
    Working: { id: 'f_working', options: [{ id: 'opt_yes', name: 'Yes' }] },
  },
}

const META_NO_WORKING: ProjectMeta = {
  projectId: 'PVT_1',
  owner: 'acme',
  fields: {
    Status: { id: 'f_status', options: [{ id: 'opt_done', name: 'Done' }] },
  },
}

const TASK: Task = {
  id: 'PVTI_1',
  title: 'My task',
  description: 'original body',
  type: 'functional',
  repos: ['web'],
  status: 'queued',
  created_at: '2024-01-01T00:00:00Z',
}

// ─── fetch helpers ────────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch

beforeAll(() => {
  process.env.GITHUB_TOKEN = 'test-token'
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

type StubCall = { url: string; body: unknown }

function stubFetch(responseBody: unknown = { data: {} }): { calls: StubCall[] } {
  const calls: StubCall[] = []
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: url as string, body: init?.body ? JSON.parse(init.body as string) : null })
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { calls }
}

function makeManager(
  opts: {
    meta?: ProjectMeta
    repoName?: string
    issueNumber?: number
    onBroadcast?: (msg: object) => void
  } = {},
) {
  const broadcast = opts.onBroadcast ?? (() => {})
  return new GitHubTaskSource(
    opts.meta ?? META,
    'PVTI_1',
    'I_issue1',
    broadcast,
    opts.repoName,
    opts.issueNumber,
  )
}

// ─── applyTransition ─────────────────────────────────────────────────────────

describe('applyTransition', () => {
  it('calls updateItemStatus and returns task with new status', async () => {
    const { calls } = stubFetch({
      data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_1' } } },
    })
    const broadcasts: object[] = []
    const manager = makeManager({ onBroadcast: (m) => broadcasts.push(m) })

    const result = await manager.applyTransition(TASK, 'Done')

    expect(result.status).toBe('Done')
    expect(calls.length).toBe(1)
    expect(broadcasts).toEqual([
      { type: 'github:transition', issueId: 'I_issue1', newStatus: 'Done' },
    ])
  })

  it('skips updateItemStatus when Status field is absent', async () => {
    const { calls } = stubFetch()
    const manager = makeManager({ meta: { ...META, fields: {} } })

    const result = await manager.applyTransition(TASK, 'Done')

    expect(result.status).toBe('Done')
    expect(calls.length).toBe(0)
  })
})

// ─── setAgentWorking ─────────────────────────────────────────────────────────

describe('setAgentWorking', () => {
  it('sets Working=Yes when working=true and field exists', async () => {
    const { calls } = stubFetch({
      data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_1' } } },
    })
    const manager = makeManager()

    await manager.setAgentWorking(TASK, true)

    expect(calls.length).toBe(1)
  })

  it('calls clearItemWorking when working=false', async () => {
    const { calls } = stubFetch({
      data: { clearProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_1' } } },
    })
    const manager = makeManager()

    await manager.setAgentWorking(TASK, false)

    expect(calls.length).toBe(1)
  })

  it('returns task unchanged when Working field is absent', async () => {
    const { calls } = stubFetch()
    const manager = makeManager({ meta: META_NO_WORKING })

    const result = await manager.setAgentWorking(TASK, true)

    expect(result).toEqual(TASK)
    expect(calls.length).toBe(0)
  })
})

// ─── saveOutput ──────────────────────────────────────────────────────────────

describe('saveOutput', () => {
  it('writes content to GitHub issue body and returns task with updated description', async () => {
    const { calls } = stubFetch({ data: {} })
    const manager = makeManager()

    const result = await manager.saveOutput(TASK, '## New body')

    expect(result.description).toBe('## New body')
    expect(calls.length).toBe(1)
    expect((calls[0].body as any).variables.body).toBe('## New body')
  })
})

// ─── postError ────────────────────────────────────────────────────────────────

describe('postError', () => {
  it('posts an error comment to the issue', async () => {
    const { calls } = stubFetch({ data: { addComment: { commentEdge: { node: { id: 'c1' } } } } })
    const manager = makeManager()

    await manager.postError(TASK, 'something went wrong')

    expect(calls.length).toBe(1)
    const body = (calls[0].body as any).variables.body as string
    expect(body).toContain('⚠️ Agent error')
    expect(body).toContain('something went wrong')
  })
})

// ─── postComment ─────────────────────────────────────────────────────────────

describe('postComment', () => {
  it('posts the given body as a comment, tagged as a system comment', async () => {
    const { calls } = stubFetch({ data: { addComment: { commentEdge: { node: { id: 'c1' } } } } })
    const manager = makeManager()

    await manager.postComment(TASK, 'hello world')

    expect(calls.length).toBe(1)
    // Tagged with `<!-- ia-flow:` so loadComments' system-comment filter
    // excludes this from `{{task.comments}}` on a future run of the task.
    expect((calls[0].body as any).variables.body).toBe(
      'hello world\n\n<!-- ia-flow:system-comment -->',
    )
  })
})

// ─── getProjectContext ────────────────────────────────────────────────────────

describe('getProjectContext', () => {
  it('returns field options from project meta', () => {
    const manager = makeManager()
    const ctx = manager.getProjectContext()

    expect(ctx['fields.status']).toBe('Done, Queue')
    expect(ctx['fields.working']).toBe('Yes')
  })
})

// ─── getSourceToolContext ────────────────────────────────────────────────────

describe('getSourceToolContext', () => {
  it('returns base context without optional fields', () => {
    const manager = makeManager()
    const ctx = manager.getSourceToolContext()

    expect(ctx.owner).toBe('acme')
    expect(ctx.projectId).toBe('PVT_1')
    expect(ctx.itemId).toBe('PVTI_1')
    expect(ctx.issueId).toBe('I_issue1')
    expect(ctx.repoName).toBeUndefined()
    expect(ctx.issueNumber).toBeUndefined()
  })

  it('includes repoName and issueNumber when provided', () => {
    const manager = makeManager({ repoName: 'my-repo', issueNumber: 42 })
    const ctx = manager.getSourceToolContext()

    expect(ctx.repoName).toBe('my-repo')
    expect(ctx.issueNumber).toBe(42)
  })
})

// ─── setFields — campo multi-valor `Labels` ──────────────────────────────────
//
// El camino que recorre un outcome `$set:Labels=+a,-b` en un source de
// Project: `applyOutcome` manda los tokens con signo tal cual a `setFields`,
// y es acá donde se resuelven contra las labels vigentes y se persisten con
// el PUT de reemplazo. Es la mitad del contrato que `field-ops.test.ts` no
// cubre — ahí se testea la resolución pura, acá que el source la use y no
// mande `Labels` al board como si fuera una columna del Project.

const LABELED_TASK: Task = { ...TASK, labels: ['agent:build', 'bug'] }

describe('setFields — campo multi-valor Labels', () => {
  it('resuelve los tokens con signo y persiste el set final con un PUT de labels', async () => {
    const { calls } = stubFetch()
    const manager = makeManager({ repoName: 'web', issueNumber: 42 })

    const updated = await manager.setFields(LABELED_TASK, { Labels: '+agent:review,-agent:build' })

    const labelCall = calls.find((c) => c.url.includes('/issues/42/labels'))
    expect(labelCall?.body).toEqual({ labels: ['bug', 'agent:review'] })
    expect(updated.labels).toEqual(['bug', 'agent:review'])
  })

  it('no manda Labels al board — no es una columna del Project', async () => {
    const { calls } = stubFetch()
    const manager = makeManager({ repoName: 'web', issueNumber: 42 })

    await manager.setFields(LABELED_TASK, { Labels: '+agent:review' })

    expect(calls.some((c) => c.url.includes('/graphql'))).toBe(false)
  })

  it('un = reemplaza el set completo', async () => {
    const { calls } = stubFetch()
    const manager = makeManager({ repoName: 'web', issueNumber: 42 })

    const updated = await manager.setFields(LABELED_TASK, { Labels: '=solo-esta' })

    const labelCall = calls.find((c) => c.url.includes('/issues/42/labels'))
    expect(labelCall?.body).toEqual({ labels: ['solo-esta'] })
    expect(updated.labels).toEqual(['solo-esta'])
  })

  it('combina un campo del board y las labels en una sola llamada a setFields', async () => {
    const { calls } = stubFetch({
      data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_1' } } },
    })
    const manager = makeManager({ repoName: 'web', issueNumber: 42 })

    const updated = await manager.setFields(LABELED_TASK, {
      Working: 'Yes',
      Labels: '+agent:review',
    })

    expect(calls.some((c) => c.url.includes('/graphql'))).toBe(true)
    const labelCall = calls.find((c) => c.url.includes('/issues/42/labels'))
    expect(labelCall?.body).toEqual({ labels: ['agent:build', 'bug', 'agent:review'] })
    expect(updated.labels).toEqual(['agent:build', 'bug', 'agent:review'])
  })
})
