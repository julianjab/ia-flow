import { GithubClient } from '@ia-flow/github-api'
import { GithubTokenAuth } from '@ia-flow/github-auth'
import { describe, expect, it, vi } from 'vitest'
import * as lib from '../index.js'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

describe('package entrypoint', () => {
  it('exports the public API', () => {
    expect(lib.GithubTool).toBeDefined()
    expect(lib.GithubToolRegistry).toBeDefined()
    expect(lib.GetIssueTool).toBeDefined()
    expect(lib.CommentIssueTool).toBeDefined()
    expect(lib.AddLabelsTool).toBeDefined()
    expect(lib.SearchIssuesTool).toBeDefined()
  })

  it('wires GithubToolRegistry end-to-end through the public API only', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ number: 1, title: 't', body: 'b', state: 'open', html_url: 'u', labels: [] }),
    )
    const client = new GithubClient({
      auth: new GithubTokenAuth('t'),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const registry = new lib.GithubToolRegistry(client)

    const result = await registry
      .get('github_get_issue')
      .handler({ owner: 'o', repo: 'r', number: 1 })

    expect(JSON.parse(result)).toMatchObject({ number: 1, title: 't' })
  })

  it('una tool concreta anda sola, instanciada directo sin pasar por el registry', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: 1, html_url: 'u' }))
    const client = new GithubClient({
      auth: new GithubTokenAuth('t'),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    const tool = new lib.CommentIssueTool(client)
    const result = await tool.handler({ owner: 'o', repo: 'r', number: 1, body: 'hi' })

    expect(result).toBe('Comentario publicado: u')
  })
})
