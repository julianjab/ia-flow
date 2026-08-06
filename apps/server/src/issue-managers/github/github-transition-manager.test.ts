import { describe, expect, it, beforeAll, afterEach } from 'bun:test'
import type { Task } from '@ia-flow/shared'
import { GitHubTransitionManager } from './github-transition-manager.js'
import type { ProjectMeta } from '../../github/project.js'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const META: ProjectMeta = {
  projectId: 'PVT_1',
  owner: 'acme',
  fields: {
    Status: { id: 'f_status', options: [{ id: 'opt_done', name: 'Done' }, { id: 'opt_queue', name: 'Queue' }] },
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

function makeManager(opts: {
  meta?: ProjectMeta
  repoName?: string
  issueNumber?: number
  onBroadcast?: (msg: object) => void
} = {}) {
  const broadcast = opts.onBroadcast ?? (() => {})
  return new GitHubTransitionManager(
    opts.meta ?? META,
    'PVTI_1',
    'I_issue1',
    'original body',
    broadcast,
    opts.repoName,
    opts.issueNumber,
  )
}

// ─── applyTransition ─────────────────────────────────────────────────────────

describe('applyTransition', () => {
  it('calls updateItemStatus and returns task with new status', async () => {
    const { calls } = stubFetch({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_1' } } } })
    const broadcasts: object[] = []
    const manager = makeManager({ onBroadcast: (m) => broadcasts.push(m) })

    const result = await manager.applyTransition(TASK, 'Done')

    expect(result.status).toBe('Done')
    expect(calls.length).toBe(1)
    expect(broadcasts).toEqual([{ type: 'github:transition', issueId: 'I_issue1', newStatus: 'Done' }])
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
    const { calls } = stubFetch({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_1' } } } })
    const manager = makeManager()

    await manager.setAgentWorking(TASK, true)

    expect(calls.length).toBe(1)
  })

  it('calls clearItemWorking when working=false', async () => {
    const { calls } = stubFetch({ data: { clearProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_1' } } } })
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
  it('writes plain markdown content directly to issue body', async () => {
    const { calls } = stubFetch({ data: {} })
    const manager = makeManager()

    const result = await manager.saveOutput(TASK, '## New body')

    expect(result.description).toBe('## New body')
    expect(calls.length).toBe(1)
    // GQL call body: { query, variables: { issueId, body } }
    expect((calls[0].body as any).variables.body).toBe('## New body')
  })

  it('converts functional PRD JSON to markdown before writing', async () => {
    const { calls } = stubFetch({})
    const manager = makeManager()
    const prd = JSON.stringify({
      problem_statement: 'Solve X',
      user_stories: [],
      out_of_scope: [],
      open_questions: [],
      impacted_repos: [],
    })

    const result = await manager.saveOutput(TASK, prd)

    expect(result.description).toContain('## 📋 Functional PRD')
    expect(result.description).toContain('original body')
    expect(calls.length).toBe(1)
  })

  it('converts technical PRD JSON to markdown before writing', async () => {
    const { calls } = stubFetch({})
    const technicalTask = { ...TASK, type: 'technical' as const }
    const manager = makeManager()
    const prd = JSON.stringify({
      'my-repo': {
        repo: 'my-repo',
        files_to_modify: [],
        test_scenarios: [],
        dependencies: [],
        open_questions: [],
      },
    })

    const result = await manager.saveOutput(technicalTask, prd)

    expect(result.description).toContain('## 🔧 Technical PRD')
    expect(calls.length).toBe(1)
  })

  it('wraps unparseable JSON in a fallback PRD code block', async () => {
    const { calls } = stubFetch({ data: {} })
    const manager = makeManager()
    const content = '{not valid json!!'

    const result = await manager.saveOutput(TASK, content)

    // prdJsonToMarkdown catches parse errors and returns a ```json block
    expect(result.description).toContain('## PRD')
    expect(result.description).toContain(content)
    expect(calls.length).toBe(1)
  })

  it('strips previous PRD section from original body before building refined body', async () => {
    const { calls } = stubFetch({})
    const manager = new GitHubTransitionManager(
      META,
      'PVTI_1',
      'I_issue1',
      'original body\n\n---\n\nold prd section',
      () => {},
    )
    const prd = JSON.stringify({
      problem_statement: 'New PRD',
      user_stories: [],
      out_of_scope: [],
      open_questions: [],
      impacted_repos: [],
    })

    const result = await manager.saveOutput(TASK, prd)

    expect(result.description).not.toContain('old prd section')
    expect(result.description).toContain('original body')
    expect(calls.length).toBe(1)
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
  it('posts the given body as a comment', async () => {
    const { calls } = stubFetch({ data: { addComment: { commentEdge: { node: { id: 'c1' } } } } })
    const manager = makeManager()

    await manager.postComment(TASK, 'hello world')

    expect(calls.length).toBe(1)
    expect((calls[0].body as any).variables.body).toBe('hello world')
  })
})

// ─── getProjectContext ────────────────────────────────────────────────────────

describe('getProjectContext', () => {
  it('returns field options from project meta', () => {
    const manager = makeManager()
    const ctx = manager.getProjectContext()

    expect(ctx['field_options.status']).toBe('Done, Queue')
    expect(ctx['field_options.working']).toBe('Yes')
  })
})

// ─── getGitHubToolContext ────────────────────────────────────────────────────

describe('getGitHubToolContext', () => {
  it('returns base context without optional fields', () => {
    const manager = makeManager()
    const ctx = manager.getGitHubToolContext()

    expect(ctx.owner).toBe('acme')
    expect(ctx.projectId).toBe('PVT_1')
    expect(ctx.itemId).toBe('PVTI_1')
    expect(ctx.issueId).toBe('I_issue1')
    expect(ctx.repoName).toBeUndefined()
    expect(ctx.issueNumber).toBeUndefined()
  })

  it('includes repoName and issueNumber when provided', () => {
    const manager = makeManager({ repoName: 'my-repo', issueNumber: 42 })
    const ctx = manager.getGitHubToolContext()

    expect(ctx.repoName).toBe('my-repo')
    expect(ctx.issueNumber).toBe(42)
  })
})
