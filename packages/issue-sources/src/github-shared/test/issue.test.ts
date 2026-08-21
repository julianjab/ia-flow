import { afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { USED_COMMENT_MARKER, fetchIssueComments, markCommentsUsed } from '../issue.js'

// ─── fetch helpers ────────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch

beforeAll(() => {
  process.env.GITHUB_TOKEN = 'test-token'
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

type StubCall = { body: unknown }

function stubFetch(): { calls: StubCall[] } {
  const calls: StubCall[] = []
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    calls.push({ body: init?.body ? JSON.parse(init.body as string) : null })
    return new Response(
      JSON.stringify({ data: { updateIssueComment: { issueComment: { id: 'c1' } } } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as unknown as typeof fetch
  return { calls }
}

function stubCommentsFetch(nodes: Array<{ id: string; body: string; createdAt: string }>): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ data: { node: { comments: { nodes } } } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch
}

describe('markCommentsUsed', () => {
  it('appends the marker to the ORIGINAL body instead of replacing it', async () => {
    const { calls } = stubFetch()

    await markCommentsUsed([{ id: 'c1', body: 'please fix the retry logic' }])

    expect(calls.length).toBe(1)
    const sentBody = (calls[0].body as any).variables.body as string
    expect(sentBody).toContain('please fix the retry logic')
    expect(sentBody).toContain(USED_COMMENT_MARKER)
  })

  it('marks every comment in the batch independently', async () => {
    const { calls } = stubFetch()

    await markCommentsUsed([
      { id: 'c1', body: 'first' },
      { id: 'c2', body: 'second' },
    ])

    expect(calls.length).toBe(2)
    const ids = calls.map((c) => (c.body as any).variables.id)
    expect(ids.sort()).toEqual(['c1', 'c2'])
  })

  it('is best-effort — a failing mutation does not reject the batch', async () => {
    globalThis.fetch = (async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch

    await expect(markCommentsUsed([{ id: 'c1', body: 'x' }])).resolves.toBeUndefined()
  })
})

describe('fetchIssueComments', () => {
  it('queries `last: 50` with no orderBy — NOT `first, orderBy: UPDATED_AT` (see comment in issue.ts on why UPDATED_AT self-sabotages)', async () => {
    const { calls } = (() => {
      const c: Array<{ body: unknown }> = []
      globalThis.fetch = (async (_url: string, init: RequestInit) => {
        c.push({ body: init?.body ? JSON.parse(init.body as string) : null })
        return new Response(JSON.stringify({ data: { node: { comments: { nodes: [] } } } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }) as unknown as typeof fetch
      return { calls: c }
    })()

    await fetchIssueComments('ISSUE_1')

    const query = (calls[0].body as any).query as string
    expect(query).toContain('last: 50')
    expect(query).not.toContain('orderBy')
  })

  it('preserves the connection order returned by GitHub (creation order, oldest→newest)', async () => {
    stubCommentsFetch([
      { id: 'c1', body: 'first, oldest', createdAt: '2024-01-01T00:00:00Z' },
      { id: 'c2', body: 'second', createdAt: '2024-01-02T00:00:00Z' },
      { id: 'c3', body: 'third, newest', createdAt: '2024-01-03T00:00:00Z' },
    ])

    const result = await fetchIssueComments('ISSUE_1')

    expect(result.map((c) => c.id)).toEqual(['c1', 'c2', 'c3'])
  })

  it('filters out system comments and already-used comments', async () => {
    stubCommentsFetch([
      { id: 'c1', body: 'human feedback', createdAt: '2024-01-01T00:00:00Z' },
      {
        id: 'c2',
        body: '# subscriptions-implementer\n\n<!-- ia-flow:system-comment -->',
        createdAt: '2024-01-02T00:00:00Z',
      },
      {
        id: 'c3',
        body: `old feedback\n\n${USED_COMMENT_MARKER}`,
        createdAt: '2024-01-03T00:00:00Z',
      },
    ])

    const result = await fetchIssueComments('ISSUE_1')

    expect(result.map((c) => c.id)).toEqual(['c1'])
  })
})
