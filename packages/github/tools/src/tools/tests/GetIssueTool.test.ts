import { GithubClient } from '@ia-flow/github-api'
import { GithubTokenAuth } from '@ia-flow/github-auth'
import { describe, expect, it, vi } from 'vitest'
import { GetIssueTool } from '../GetIssueTool.js'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function clientWith(fetchImpl: typeof fetch) {
  return new GithubClient({ auth: new GithubTokenAuth('t'), fetchImpl })
}

describe('github_get_issue', () => {
  it('fetches the issue and summarizes it, normalizing label objects to names', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe('https://api.github.com/repos/julianjab/accountant/issues/42')
      return jsonResponse({
        number: 42,
        title: 'App crashes',
        body: 'steps...',
        state: 'open',
        html_url: 'https://github.com/julianjab/accountant/issues/42',
        labels: [{ name: 'bug' }, { name: 'p1' }],
      })
    })
    const tool = new GetIssueTool(clientWith(fetchImpl as unknown as typeof fetch))

    const result = await tool.handler({ owner: 'julianjab', repo: 'accountant', number: 42 })

    expect(JSON.parse(result)).toEqual({
      number: 42,
      title: 'App crashes',
      body: 'steps...',
      state: 'open',
      labels: ['bug', 'p1'],
      url: 'https://github.com/julianjab/accountant/issues/42',
    })
  })

  it('defaults body to an empty string when GitHub returns null', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ number: 1, title: 't', body: null, state: 'open', html_url: 'u', labels: [] }),
    )
    const tool = new GetIssueTool(clientWith(fetchImpl as unknown as typeof fetch))

    const result = await tool.handler({ owner: 'o', repo: 'r', number: 1 })

    expect(JSON.parse(result).body).toBe('')
  })

  it('rejects an owner/repo containing a path traversal segment instead of hitting the wrong endpoint', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }))
    const tool = new GetIssueTool(clientWith(fetchImpl as unknown as typeof fetch))

    await expect(
      tool.handler({ owner: 'o', repo: '../../orgs/other-org/repos', number: 1 }),
    ).rejects.toThrow('repo')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects a non-integer or non-positive issue number', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }))
    const tool = new GetIssueTool(clientWith(fetchImpl as unknown as typeof fetch))

    await expect(tool.handler({ owner: 'o', repo: 'r', number: 1.5 })).rejects.toThrow('number')
    await expect(tool.handler({ owner: 'o', repo: 'r', number: -1 })).rejects.toThrow('number')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('accepts a legitimate owner/repo containing dots, dashes and underscores', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe('https://api.github.com/repos/my-org_2/repo.name/issues/1')
      return jsonResponse({
        number: 1,
        title: 't',
        body: '',
        state: 'open',
        html_url: 'u',
        labels: [],
      })
    })
    const tool = new GetIssueTool(clientWith(fetchImpl as unknown as typeof fetch))

    await tool.handler({ owner: 'my-org_2', repo: 'repo.name', number: 1 })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('a non-ok response throws — the caller (AnthropicProvider) turns it into an is_error tool_result', async () => {
    const fetchImpl = vi.fn(async () => new Response('not found', { status: 404 }))
    const tool = new GetIssueTool(clientWith(fetchImpl as unknown as typeof fetch))

    await expect(tool.handler({ owner: 'o', repo: 'r', number: 999 })).rejects.toThrow('404')
  })

  it('rejects a number sent as a string instead of coercing it', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }))
    const tool = new GetIssueTool(clientWith(fetchImpl as unknown as typeof fetch))

    await expect(tool.handler({ owner: 'o', repo: 'r', number: '5' })).rejects.toThrow(
      /github_get_issue: input inválido[\s\S]*→ at number/,
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
