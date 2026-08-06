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

// ─── validate ────────────────────────────────────────────────────────────────

describe('validate', () => {
  it('is not implemented — item filtering is delegated to agent config', () => {
    const manager = managerWithMeta()
    expect((manager as unknown as { validate?: unknown }).validate).toBeUndefined()
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
