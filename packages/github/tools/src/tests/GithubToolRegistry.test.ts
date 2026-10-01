import { GithubClient } from '@ia-flow/github-api'
import { GithubTokenAuth } from '@ia-flow/github-auth'
import { describe, expect, it, vi } from 'vitest'
import { GithubToolRegistry } from '../GithubToolRegistry.js'

function registryWith(fetchImpl: typeof fetch = vi.fn() as unknown as typeof fetch) {
  const client = new GithubClient({ auth: new GithubTokenAuth('t'), fetchImpl })
  return new GithubToolRegistry(client)
}

describe('GithubToolRegistry', () => {
  it('names() lists every registered tool', () => {
    expect(registryWith().names()).toEqual([
      'github_get_issue',
      'github_comment_issue',
      'github_add_labels',
      'github_search_issues',
    ])
  })

  it('all() returns the same tools as names()', () => {
    const registry = registryWith()
    expect(registry.all().map((tool) => tool.name)).toEqual(registry.names())
  })

  it('get(name) resolves a single tool by name', () => {
    const tool = registryWith().get('github_comment_issue')
    expect(tool.name).toBe('github_comment_issue')
  })

  it('get(name) throws a helpful error for an unknown name instead of returning undefined', () => {
    expect(() => registryWith().get('github_delete_repo')).toThrow('github_delete_repo')
    expect(() => registryWith().get('github_delete_repo')).toThrow('github_get_issue')
  })

  it('resolve(names) maps a list of names to their Tools, in order — the config-driven case', () => {
    const resolved = registryWith().resolve(['github_search_issues', 'github_get_issue'])
    expect(resolved.map((tool) => tool.name)).toEqual(['github_search_issues', 'github_get_issue'])
  })

  it('resolve(names) throws on the first unknown name, same as get()', () => {
    expect(() => registryWith().resolve(['github_get_issue', 'nope'])).toThrow('nope')
  })

  it('each tool returned by the registry is wired to the same GithubClient (shares fetchImpl)', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            number: 1,
            title: 't',
            body: '',
            state: 'open',
            html_url: 'u',
            labels: [],
          }),
          { status: 200 },
        ),
    )
    const registry = registryWith(fetchImpl as unknown as typeof fetch)

    await registry.get('github_get_issue').handler({ owner: 'o', repo: 'r', number: 1 })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
