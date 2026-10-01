import { describe, expect, it } from 'vitest'
import { GithubTokenAuth } from '../GithubTokenAuth.js'

describe('GithubTokenAuth', () => {
  it('returns the token it was constructed with, unchanged', async () => {
    const auth = new GithubTokenAuth('ghp_example123')
    await expect(auth.getToken()).resolves.toBe('ghp_example123')
  })

  it('returns the same token on repeated calls — no caching logic to break', async () => {
    const auth = new GithubTokenAuth('gho_user-oauth-token')
    const a = await auth.getToken()
    const b = await auth.getToken()
    expect(a).toBe(b)
    expect(a).toBe('gho_user-oauth-token')
  })
})
