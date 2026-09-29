import { GithubTokenAuth } from '@ia-flow/github-auth'
import { describe, expect, it } from 'vitest'
import * as lib from '../index.js'

describe('package entrypoint', () => {
  it('exports the public API', () => {
    expect(lib.GithubClient).toBeDefined()
  })

  it('wires GithubClient with a GithubAuth from @ia-flow/github-auth end-to-end', async () => {
    const fetchImpl = async () => new Response('{}', { status: 200 })
    const client = new lib.GithubClient({
      auth: new GithubTokenAuth('t'),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await expect(client.request('/x')).resolves.toBeInstanceOf(Response)
  })
})
