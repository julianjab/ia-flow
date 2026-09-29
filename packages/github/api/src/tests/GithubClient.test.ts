import type { GithubAuth } from '@ia-flow/github-auth'
import { describe, expect, it, vi } from 'vitest'
import { GithubClient } from '../GithubClient.js'

function fakeAuth(token: string): GithubAuth {
  return { getToken: async () => token }
}

describe('GithubClient.request', () => {
  it('resolves the token via GithubAuth and sends the standard headers', async () => {
    let capturedInit: RequestInit | undefined
    let capturedUrl: string | undefined
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      capturedUrl = url
      capturedInit = init
      return new Response('{}', { status: 200 })
    })
    const client = new GithubClient({
      auth: fakeAuth('ghs_x'),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await client.request('/repos/o/r/issues/1')

    expect(capturedUrl).toBe('https://api.github.com/repos/o/r/issues/1')
    const headers = capturedInit?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer ghs_x')
    expect(headers.Accept).toBe('application/vnd.github+json')
    expect(headers['X-GitHub-Api-Version']).toBe('2022-11-28')
  })

  it('passes an absolute URL through unchanged (ej. seguir un Link header)', async () => {
    let capturedUrl: string | undefined
    const fetchImpl = vi.fn(async (url: string) => {
      capturedUrl = url
      return new Response('{}', { status: 200 })
    })
    const client = new GithubClient({
      auth: fakeAuth('t'),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await client.request('https://api.github.com/repositories/1/issues?page=2')

    expect(capturedUrl).toBe('https://api.github.com/repositories/1/issues?page=2')
  })

  it('rejects an absolute URL pointing at a different host instead of leaking the token there', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }))
    const client = new GithubClient({
      auth: fakeAuth('secret-token'),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await expect(client.request('https://evil.example.com/steal')).rejects.toThrow(
      'fuera de la API de GitHub',
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects a relative path that escapes the API host via encoded traversal', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }))
    const client = new GithubClient({
      auth: fakeAuth('t'),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    // `new URL('//evil.example.com/x', 'https://api.github.com')` resuelve a otro host —
    // protocol-relative dentro de un path es una forma clásica de escapar un chequeo ingenuo.
    await expect(client.request('//evil.example.com/x')).rejects.toThrow(
      'fuera de la API de GitHub',
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('sets content-type only when there is a body', async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>
      expect(headers['content-type']).toBe('application/json')
      return new Response('{}', { status: 200 })
    })
    const client = new GithubClient({
      auth: fakeAuth('t'),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await client.request('/x', { method: 'POST', body: JSON.stringify({ a: 1 }) })
  })
})

describe('GithubClient.requestJson', () => {
  it('returns the parsed JSON body on a 2xx response', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    const client = new GithubClient({
      auth: fakeAuth('t'),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    const result = await client.requestJson<{ ok: boolean }>('/x')

    expect(result).toEqual({ ok: true })
  })

  it('throws with the response body on a non-2xx response', async () => {
    const fetchImpl = vi.fn(async () => new Response('not found', { status: 404 }))
    const client = new GithubClient({
      auth: fakeAuth('t'),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await expect(client.requestJson('/x')).rejects.toThrow('404')
  })
})

describe('GithubClient.graphql', () => {
  function clientReturning(body: unknown, capture: { init?: RequestInit; url?: string } = {}) {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      capture.url = url
      capture.init = init
      return new Response(JSON.stringify(body), { status: 200 })
    })
    return new GithubClient({
      auth: fakeAuth('t'),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
  }

  it('POSTs the query and variables to /graphql and returns data', async () => {
    const capture: { init?: RequestInit; url?: string } = {}
    const client = clientReturning({ data: { viewer: { login: 'x' } } }, capture)

    const data = await client.graphql<{ viewer: { login: string } }>('query { viewer { login } }', {
      a: 1,
    })

    expect(data.viewer.login).toBe('x')
    expect(capture.url).toBe('https://api.github.com/graphql')
    expect(capture.init?.method).toBe('POST')
    expect(JSON.parse(capture.init?.body as string)).toEqual({
      query: 'query { viewer { login } }',
      variables: { a: 1 },
    })
  })

  it('throws with GitHub messages when the response carries errors, even with status 200', async () => {
    const client = clientReturning({
      data: null,
      errors: [{ message: 'Could not resolve to a node' }, { message: 'otro' }],
    })

    await expect(client.graphql('query { x }')).rejects.toThrow(
      'GraphQL → Could not resolve to a node; otro',
    )
  })

  it('throws when the response has no data', async () => {
    const client = clientReturning({})

    await expect(client.graphql('query { x }')).rejects.toThrow('GraphQL respondió sin data')
  })
})
