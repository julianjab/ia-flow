import { GithubClient } from '@ia-flow/github-api'
import { GithubTokenAuth } from '@ia-flow/github-auth'
import { describe, expect, it, vi } from 'vitest'
import { SearchIssuesTool } from '../SearchIssuesTool.js'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function clientWith(fetchImpl: typeof fetch) {
  return new GithubClient({ auth: new GithubTokenAuth('t'), fetchImpl })
}

describe('github_search_issues', () => {
  it('URL-encodes the query and summarizes every matching issue', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe(
        'https://api.github.com/search/issues?q=repo%3Ao%2Fr%20is%3Aopen%20label%3Abug',
      )
      return jsonResponse({
        items: [
          { number: 1, title: 't1', body: 'b1', state: 'open', html_url: 'u1', labels: ['bug'] },
        ],
      })
    })
    const tool = new SearchIssuesTool(clientWith(fetchImpl as unknown as typeof fetch))

    const result = await tool.handler({ query: 'repo:o/r is:open label:bug' })

    expect(JSON.parse(result)).toHaveLength(1)
    expect(JSON.parse(JSON.parse(result)[0])).toMatchObject({ number: 1, title: 't1' })
  })

  it('rejects a missing query instead of searching for "undefined"', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"items":[]}', { status: 200 }))
    const tool = new SearchIssuesTool(clientWith(fetchImpl as unknown as typeof fetch))

    await expect(tool.handler({})).rejects.toThrow(/github_search_issues: input inválido/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
