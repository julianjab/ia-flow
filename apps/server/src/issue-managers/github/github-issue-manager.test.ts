import { describe, expect, it, beforeAll, afterEach } from 'bun:test'
import { GitHubIssueManager } from './github-issue-manager.js'
import { GitHubTransitionManager } from './github-transition-manager.js'
import type { IssueItem } from '../types.js'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch

beforeAll(() => {
  process.env.GITHUB_TOKEN = 'test-token'
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

const PROJECT_META = {
  projectId: 'PVT_1',
  owner: 'acme',
  fields: {
    Status: { id: 'f_status', options: [{ id: 'opt_queue', name: 'Queue' }] },
    Working: { id: 'f_working', options: [{ id: 'opt_yes', name: 'Yes' }] },
  },
}

function makeItem(overrides: Partial<IssueItem> = {}): IssueItem {
  return {
    id: 'PVTI_1',
    title: 'Test issue',
    description: 'body',
    type: 'functional',
    repos: ['web'],
    status: 'Queue',
    meta: {
      issueId: 'I_1',
      issueNumber: 10,
      repoName: 'my-repo',
      owner: 'acme',
    },
    ...overrides,
  }
}

type FetchCall = { url: string; body: unknown }

function stubFetch(responses: unknown[] = [{}]): { calls: FetchCall[] } {
  const calls: FetchCall[] = []
  let i = 0
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const body = responses[i] ?? responses[responses.length - 1] ?? {}
    i++
    calls.push({ url: url as string, body: init?.body ? JSON.parse(init.body as string) : null })
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { calls }
}

function managerWithMeta(): GitHubIssueManager {
  const m = new GitHubIssueManager('https://github.com/orgs/acme/projects/1', () => {})
  ;(m as any).meta = PROJECT_META
  return m
}

// GQL response for findValidationComment (no existing comment)
const GQL_NO_COMMENT = { data: { node: { comments: { nodes: [] } } } }
// GQL response for addIssueComment
const GQL_ADD_COMMENT = { data: { addComment: { commentEdge: { node: { id: 'c_1' } } } } }

// ─── validate — backlog items ─────────────────────────────────────────────────

describe('validate — backlog', () => {
  it('returns ok and clears validation comment for backlog items', async () => {
    const { calls } = stubFetch([GQL_NO_COMMENT])
    const manager = managerWithMeta()
    const item = makeItem({ status: 'Backlog', repos: [], type: '' })

    const result = await manager.validate(item)

    expect(result.ok).toBe(true)
    expect(calls.length).toBe(1) // clearValidationComment → findValidationComment
  })

  it('returns ok without fetch when backlog item has no issueId', async () => {
    const { calls } = stubFetch()
    const manager = managerWithMeta()
    const item = makeItem({ status: 'Backlog', meta: {} })

    const result = await manager.validate(item)

    expect(result.ok).toBe(true)
    expect(calls.length).toBe(0)
  })
})

// ─── validate — missing required fields ──────────────────────────────────────

describe('validate — missing fields', () => {
  it('fails when repos is empty', async () => {
    // upsertValidationComment: findValidationComment + addIssueComment
    stubFetch([GQL_NO_COMMENT, GQL_ADD_COMMENT])
    const manager = managerWithMeta()
    const item = makeItem({ repos: [], type: 'functional' })

    const result = await manager.validate(item)

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('Repos')
  })

  it('fails when type is empty', async () => {
    stubFetch([GQL_NO_COMMENT, GQL_ADD_COMMENT])
    const manager = managerWithMeta()
    const item = makeItem({ repos: ['web'], type: '' })

    const result = await manager.validate(item)

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('Task Type')
  })

  it('reports both missing fields when both absent', async () => {
    stubFetch([GQL_NO_COMMENT, GQL_ADD_COMMENT])
    const manager = managerWithMeta()
    const item = makeItem({ repos: [], type: '' })

    const result = await manager.validate(item)

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('Repos')
    expect(result.reason).toContain('Task Type')
  })

  it('posts a validation comment when issueId is present and fields are missing', async () => {
    // findValidationComment, then addIssueComment mutation
    const { calls } = stubFetch([GQL_NO_COMMENT, GQL_ADD_COMMENT])
    const manager = managerWithMeta()
    const item = makeItem({ repos: [], type: '' })

    await manager.validate(item)

    expect(calls.length).toBe(2)
    // second call is addIssueComment mutation
    const body = (calls[1].body as any).variables?.body as string
    expect(body).toContain('⏸️')
  })
})

// ─── validate — valid item ────────────────────────────────────────────────────

describe('validate — valid item', () => {
  it('returns ok for item with repos and type', async () => {
    // clearValidationComment → findValidationComment (no comment)
    const { calls } = stubFetch([GQL_NO_COMMENT])
    const manager = managerWithMeta()
    const item = makeItem({ repos: ['web'], type: 'functional', status: 'Queue' })

    const result = await manager.validate(item)

    expect(result.ok).toBe(true)
    expect(calls.length).toBe(1)
  })

  it('checks for blocking issues when type=technical and status=Approved', async () => {
    // findValidationComment (no comment) + getBlockingIssues REST (returns empty array = no blockers)
    stubFetch([GQL_NO_COMMENT, []])
    const manager = managerWithMeta()
    const item = makeItem({
      repos: ['web'],
      type: 'technical',
      status: 'Approved',
      meta: { issueId: 'I_1', issueNumber: 10, repoName: 'my-repo', owner: 'acme' },
    })

    const result = await manager.validate(item)

    expect(result.ok).toBe(true)
  })
})

// ─── getTransitionManager ─────────────────────────────────────────────────────

describe('getTransitionManager', () => {
  it('always returns GitHubTransitionManager', () => {
    const manager = managerWithMeta()
    const item = makeItem({ status: 'Backlog' })

    const tm = manager.getTransitionManager(item)

    expect(tm).toBeInstanceOf(GitHubTransitionManager)
  })

  it('returns GitHubTransitionManager for non-backlog items too', () => {
    const manager = managerWithMeta()
    const item = makeItem({ status: 'Queue' })

    const tm = manager.getTransitionManager(item)

    expect(tm).toBeInstanceOf(GitHubTransitionManager)
  })

  it('passes repoName and issueNumber from item meta', () => {
    const manager = managerWithMeta()
    const item = makeItem({ meta: { issueId: 'I_1', issueNumber: 99, repoName: 'backend', owner: 'acme' } })

    const tm = manager.getTransitionManager(item)
    const ctx = (tm as GitHubTransitionManager).getGitHubToolContext()

    expect(ctx.repoName).toBe('backend')
    expect(ctx.issueNumber).toBe(99)
  })
})
