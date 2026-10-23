import { describe, expect, it } from 'bun:test'
import { GithubClient } from '@ia-flow/github-api'
import { GithubTokenAuth } from '@ia-flow/github-auth'
import {
  issuesWebhookRepo,
  nextLink,
  type RepoIssuesRead,
  RepoIssuesReader,
  withoutCards,
} from './RepoIssuesReader.js'

const issue = (number: number, patch: Record<string, unknown> = {}) => ({
  number,
  title: `Issue ${number}`,
  html_url: `https://github.com/O/R/issues/${number}`,
  repository_url: 'https://api.github.com/repos/O/R',
  updated_at: `2026-10-${String(30 - (number % 28)).padStart(2, '0')}T00:00:00Z`,
  user: { login: 'julian' },
  labels: [{ name: 'bug' }],
  ...patch,
})

/** GitHub de mentira: cada repo responde sus páginas en orden; `next` arma el header `Link`. */
function fakeGithub(pages: Record<string, Array<{ status?: number; body?: unknown[] }>>) {
  const calls: string[] = []
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input))
    calls.push(url.toString())
    const repo = /\/repos\/([^/]+\/[^/]+)\/issues/.exec(url.pathname)?.[1] ?? ''
    const index = Number(url.searchParams.get('page') ?? '1') - 1
    const list = pages[repo] ?? []
    const page = list[index]
    if (!page) return Response.json({ message: 'Not Found' }, { status: 404 })
    if (page.status) return Response.json({ message: 'nope' }, { status: page.status })
    const headers: Record<string, string> = {}
    if (index + 1 < list.length) {
      const next = new URL(url)
      next.searchParams.set('page', String(index + 2))
      headers.link = `<${next}>; rel="next", <${next}>; rel="last"`
    }
    return Response.json(page.body ?? [], { headers })
  }) as typeof fetch
  const client = new GithubClient({ auth: new GithubTokenAuth('t'), fetchImpl })
  return { calls, reader: new RepoIssuesReader(client) }
}

describe('RepoIssuesReader', () => {
  it('reads the open issues of a repo, newest first, without pull requests', async () => {
    const { calls, reader } = fakeGithub({
      'o/r': [{ body: [issue(1), issue(2, { pull_request: { url: 'x' } }), issue(3)] }],
    })
    const read = await reader.issues('o/r')
    expect(calls[0]).toBe(
      'https://api.github.com/repos/o/r/issues?state=open&sort=updated&direction=desc&per_page=100',
    )
    expect(read).toEqual({
      issues: [
        {
          ref: 'O/R#1',
          title: 'Issue 1',
          url: 'https://github.com/O/R/issues/1',
          labels: ['bug'],
          updatedAt: issue(1).updated_at,
          author: 'julian',
        },
        expect.objectContaining({ ref: 'O/R#3' }),
      ],
      more: false,
    })
  })

  it('follows the pages up to its cap and says there is more', async () => {
    const page = (from: number) => ({
      body: Array.from({ length: 100 }, (_, i) => issue(from + i)),
    })
    const { calls, reader } = fakeGithub({
      'o/r': [page(1), page(101), page(201), page(301)],
    })
    const read = await reader.issues('o/r')
    expect(calls).toHaveLength(3)
    expect(read.issues).toHaveLength(300)
    expect(read.more).toBe(true)
  })

  it('a repo it cannot read comes back with a short error, not an exception', async () => {
    const { reader } = fakeGithub({ 'o/private': [{ status: 403 }] })
    expect(await reader.issues('o/private')).toEqual({
      issues: [],
      more: false,
      error: 'El runner no tiene permiso para leer sus issues',
    })
    expect((await reader.issues('o/missing')).error).toBe(
      'El repo no existe o el runner no tiene acceso',
    )
  })

  it('caches per repo, and an invalidation drops only that repo', async () => {
    const { calls, reader } = fakeGithub({ 'o/a': [{ body: [issue(1)] }], 'o/b': [{ body: [] }] })
    await reader.issues('o/a')
    await reader.issues('o/b')
    await reader.issues('o/a')
    expect(calls).toHaveLength(2)
    reader.invalidate('O/A')
    await reader.issues('o/a')
    await reader.issues('o/b')
    expect(calls).toHaveLength(3)
    expect(calls[2]).toContain('/repos/o/a/')
  })
})

describe('withoutCards', () => {
  const read = (count: number, more = false): RepoIssuesRead => ({
    issues: Array.from({ length: count }, (_, i) => ({
      ref: `O/R#${i + 1}`,
      title: `Issue ${i + 1}`,
      url: `https://github.com/O/R/issues/${i + 1}`,
      labels: [],
      updatedAt: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
    })),
    more,
  })

  it('drops what already has a card (any case), newest first', () => {
    const repo = withoutCards({ repo: 'o/r', projectId: 'p' }, read(3), new Set(['o/r#2']))
    expect(repo).toEqual({
      repo: 'o/r',
      project_id: 'p',
      items: [
        expect.objectContaining({ ref: 'O/R#3', project_id: 'p' }),
        expect.objectContaining({ ref: 'O/R#1', project_id: 'p' }),
      ],
    })
  })

  it('caps at 100 per repo and marks it truncated, also when GitHub had more', () => {
    const capped = withoutCards({ repo: 'o/r', projectId: 'p' }, read(150), new Set())
    expect(capped.items).toHaveLength(100)
    expect(capped.truncated).toBe(true)
    expect(withoutCards({ repo: 'o/r', projectId: 'p' }, read(2, true), new Set()).truncated).toBe(
      true,
    )
  })

  it('keeps the error of a repo it could not read', () => {
    const failed = withoutCards(
      { repo: 'o/r', projectId: 'p' },
      { issues: [], more: false, error: 'sin acceso' },
      new Set(),
    )
    expect(failed).toEqual({ repo: 'o/r', project_id: 'p', items: [], error: 'sin acceso' })
  })
})

describe('helpers', () => {
  it('nextLink reads the next page of a Link header', () => {
    expect(nextLink('<https://api.github.com/x?page=2>; rel="next", <y>; rel="last"')).toBe(
      'https://api.github.com/x?page=2',
    )
    expect(nextLink('<y>; rel="prev"')).toBeUndefined()
    expect(nextLink(null)).toBeUndefined()
  })

  it('issuesWebhookRepo only answers issues.* webhooks', () => {
    expect(issuesWebhookRepo('issues', { repository: { full_name: 'O/R' } })).toBe('o/r')
    expect(issuesWebhookRepo('pull_request', { repository: { full_name: 'O/R' } })).toBeUndefined()
    expect(issuesWebhookRepo('issues', {})).toBeUndefined()
  })
})
