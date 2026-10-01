import { describe, expect, it } from 'vitest'
import * as lib from '../index.js'

describe('package entrypoint', () => {
  it('exports the public API', () => {
    expect(lib.GithubTokenAuth).toBeDefined()
    expect(lib.GithubAppAuth).toBeDefined()
  })

  it('GithubTokenAuth satisfies the GithubAuth interface', async () => {
    const auth = new lib.GithubTokenAuth('t')
    await expect(auth.getToken()).resolves.toBe('t')
  })
})
