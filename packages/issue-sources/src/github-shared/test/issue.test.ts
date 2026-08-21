import { afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { USED_COMMENT_MARKER, markCommentsUsed } from '../issue.js'

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
