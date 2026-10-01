import { verify as cryptoVerify, generateKeyPairSync } from 'node:crypto'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { GithubAppAuth } from '../GithubAppAuth.js'

let privateKey: string
let publicKey: string

beforeAll(() => {
  const pair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  privateKey = pair.privateKey
  publicKey = pair.publicKey
})

function decodeJwt(token: string): {
  header: Record<string, unknown>
  payload: Record<string, unknown>
} {
  const [header, payload] = token.split('.')
  return {
    header: JSON.parse(Buffer.from(header, 'base64url').toString('utf8')),
    payload: JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
  }
}

function verifyJwtSignature(token: string, pubKey: string): boolean {
  const [header, payload, signature] = token.split('.')
  return cryptoVerify(
    'RSA-SHA256',
    Buffer.from(`${header}.${payload}`),
    pubKey,
    Buffer.from(signature, 'base64url'),
  )
}

function tokenResponse(token: string, expiresAt: string) {
  return new Response(JSON.stringify({ token, expires_at: expiresAt }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('GithubAppAuth', () => {
  it('signs a well-formed App JWT (RS256, correct claims) and exchanges it for an installation token', async () => {
    let capturedAuthHeader: string | undefined
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      capturedAuthHeader = (init.headers as Record<string, string>).Authorization
      return tokenResponse('ghs_installation-token', new Date(Date.now() + 3600_000).toISOString())
    })

    const auth = new GithubAppAuth({
      appId: '4752324',
      installationId: '157297744',
      privateKey,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    const token = await auth.getToken()

    expect(token).toBe('ghs_installation-token')
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.github.com/app/installations/157297744/access_tokens',
      expect.objectContaining({ method: 'POST' }),
    )

    const jwt = capturedAuthHeader?.replace('Bearer ', '') ?? ''
    const { header, payload } = decodeJwt(jwt)
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT' })
    expect(payload.iss).toBe('4752324')
    expect(payload.exp as number).toBeGreaterThan(payload.iat as number)
    expect(verifyJwtSignature(jwt, publicKey)).toBe(true)
  })

  it('caches the installation token across calls instead of re-exchanging every time', async () => {
    const fetchImpl = vi.fn(async () =>
      tokenResponse('ghs_cached', new Date(Date.now() + 3600_000).toISOString()),
    )
    const auth = new GithubAppAuth({
      appId: 'a',
      installationId: 'i',
      privateKey,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await auth.getToken()
    await auth.getToken()
    await auth.getToken()

    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('refreshes once the cached token is within the refresh margin of expiring', async () => {
    let calls = 0
    // `expires_at` relativo a la MISMA base que el `now` fake que le pasamos a `getToken` —
    // usar `Date.now()` real acá desalinea las dos escalas de tiempo y el test "prueba" un
    // escenario que nunca vence según el reloj falso.
    const fetchImpl = vi.fn(async () => {
      calls++
      return tokenResponse(`ghs_${calls}`, new Date(1_000_000 + 3600_000).toISOString())
    })
    const auth = new GithubAppAuth({
      appId: 'a',
      installationId: 'i',
      privateKey,
      refreshMarginMs: 5 * 60_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    const first = await auth.getToken(1_000_000)
    // Todavía lejos del margen de refresco.
    const stillCached = await auth.getToken(1_000_000 + 10_000)
    // Justo dentro del margen (menos de 5 min antes de vencer).
    const refreshed = await auth.getToken(1_000_000 + 3600_000 - 4 * 60_000)

    expect(first).toBe('ghs_1')
    expect(stillCached).toBe('ghs_1')
    expect(refreshed).toBe('ghs_2')
    expect(calls).toBe(2)
  })

  it('throws with the response body on a non-ok exchange', async () => {
    const fetchImpl = vi.fn(async () => new Response('bad credentials', { status: 401 }))
    const auth = new GithubAppAuth({
      appId: 'a',
      installationId: 'i',
      privateKey,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await expect(auth.getToken()).rejects.toThrow('401')
  })
})
