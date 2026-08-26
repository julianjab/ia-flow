import { describe, expect, it } from 'bun:test'
import { createVerify, generateKeyPairSync } from 'node:crypto'
import { GitHubAppCredentials, normalizePrivateKey, signAppJwt } from './github-app.js'

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})

const NOW = Date.parse('2026-08-26T12:00:00Z')

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** Fetch de mentira que devuelve una respuesta por path y cuenta las llamadas. */
function stubFetch(routes: Record<string, () => Response>) {
  const calls: string[] = []
  const fn = async (url: string) => {
    const path = url.replace('https://api.github.com', '')
    calls.push(path)
    const handler = routes[path]
    if (!handler) return new Response(`no route for ${path}`, { status: 404 })
    return handler()
  }
  return { fn, calls }
}

function tokenRoute(token: string, expiresAt: string) {
  return () => jsonResponse({ token, expires_at: expiresAt })
}

describe('normalizePrivateKey', () => {
  it('acepta el PEM crudo tal como sale de GitHub', () => {
    expect(normalizePrivateKey(privateKey)).toBe(privateKey.trim())
  })

  it('acepta el PEM en base64', () => {
    const encoded = Buffer.from(privateKey).toString('base64')
    expect(normalizePrivateKey(encoded)).toBe(privateKey.trim())
  })

  it('rearma los saltos de línea que un .env convierte en \\n literales', () => {
    const escaped = privateKey.trim().replace(/\n/g, '\\n')
    expect(normalizePrivateKey(escaped)).toBe(privateKey.trim())
  })

  it('falla con un mensaje útil, no con un error de OpenSSL', () => {
    expect(() => normalizePrivateKey('no-soy-una-key')).toThrow(/no parece un PEM/)
  })
})

describe('signAppJwt', () => {
  it('firma un JWT RS256 verificable con la public key', () => {
    const jwt = signAppJwt('123456', privateKey, NOW)
    const [header, payload, signature] = jwt.split('.')

    const verifier = createVerify('RSA-SHA256')
    verifier.update(`${header}.${payload}`)
    expect(verifier.verify(publicKey, Buffer.from(signature, 'base64url'))).toBe(true)

    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    })
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString())
    expect(claims.iss).toBe('123456')
    // Backdateado 60s: GitHub rechaza un `iat` en el futuro si el reloj del
    // host está adelantado.
    expect(claims.iat).toBe(Math.floor(NOW / 1000) - 60)
    // Y por debajo del máximo de 10' que GitHub acepta.
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600)
  })
})

describe('GitHubAppCredentials', () => {
  const base = { appId: '123456', privateKey, installationId: '99' }

  it('cambia el JWT por un installation token', async () => {
    const { fn, calls } = stubFetch({
      '/app/installations/99/access_tokens': tokenRoute('ghs_installation', '2026-08-26T13:00:00Z'),
    })
    const creds = new GitHubAppCredentials({ ...base, fetch: fn, now: () => NOW })
    expect(await creds.getToken()).toBe('ghs_installation')
    expect(calls).toEqual(['/app/installations/99/access_tokens'])
    expect(creds.describe()).toEqual({ mode: 'github-app', identity: 'app:123456' })
  })

  it('reusa el token mientras siga vigente', async () => {
    const { fn, calls } = stubFetch({
      '/app/installations/99/access_tokens': tokenRoute('ghs_a', '2026-08-26T13:00:00Z'),
    })
    const creds = new GitHubAppCredentials({ ...base, fetch: fn, now: () => NOW })
    await creds.getToken()
    await creds.getToken()
    expect(calls.length).toBe(1)
  })

  it('renueva ANTES del vencimiento, no en el filo', async () => {
    // El token vence 13:00. A las 12:57 quedan 3' — menos que el margen de 5' —
    // así que un run que arranca acá tiene que salir con uno nuevo, no con uno
    // que se le vence a mitad de camino.
    let token = 'ghs_viejo'
    const { fn, calls } = stubFetch({
      '/app/installations/99/access_tokens': () =>
        jsonResponse({ token, expires_at: '2026-08-26T13:00:00Z' }),
    })
    let now = NOW
    const creds = new GitHubAppCredentials({ ...base, fetch: fn, now: () => now })
    expect(await creds.getToken()).toBe('ghs_viejo')

    now = Date.parse('2026-08-26T12:57:00Z')
    token = 'ghs_nuevo'
    expect(await creds.getToken()).toBe('ghs_nuevo')
    expect(calls.length).toBe(2)
  })

  it('dedupea renovaciones concurrentes en una sola llamada', async () => {
    const { fn, calls } = stubFetch({
      '/app/installations/99/access_tokens': tokenRoute('ghs_a', '2026-08-26T13:00:00Z'),
    })
    const creds = new GitHubAppCredentials({ ...base, fetch: fn, now: () => NOW })
    const all = await Promise.all([creds.getToken(), creds.getToken(), creds.getToken()])
    expect(all).toEqual(['ghs_a', 'ghs_a', 'ghs_a'])
    expect(calls.length).toBe(1)
  })

  it('descubre la instalación única cuando no hay installationId configurado', async () => {
    const { fn, calls } = stubFetch({
      '/app/installations': () => jsonResponse([{ id: 77, account: { login: 'lahaus' } }]),
      '/app/installations/77/access_tokens': tokenRoute('ghs_77', '2026-08-26T13:00:00Z'),
    })
    const creds = new GitHubAppCredentials({
      appId: '123456',
      privateKey,
      fetch: fn,
      now: () => NOW,
    })
    expect(await creds.getToken()).toBe('ghs_77')
    expect(calls).toContain('/app/installations')
  })

  it('exige elegir cuando la app está instalada en varias cuentas', async () => {
    const { fn } = stubFetch({
      '/app/installations': () =>
        jsonResponse([
          { id: 1, account: { login: 'lahaus' } },
          { id: 2, account: { login: 'julianjab' } },
        ]),
    })
    const creds = new GitHubAppCredentials({
      appId: '123456',
      privateKey,
      fetch: fn,
      now: () => NOW,
    })
    expect(creds.getToken()).rejects.toThrow(/INSTALLATION_ID/)
  })

  it('avisa cuando la app no está instalada en ningún lado', async () => {
    const { fn } = stubFetch({ '/app/installations': () => jsonResponse([]) })
    const creds = new GitHubAppCredentials({
      appId: '123456',
      privateKey,
      fetch: fn,
      now: () => NOW,
    })
    expect(creds.getToken()).rejects.toThrow(/no está instalada/)
  })

  it('resuelve la instalación por repo y la recuerda', async () => {
    // Multi-org: el token de una instalación da 404 en los repos de la otra,
    // así que el scope tiene que llegar hasta acá.
    const { fn, calls } = stubFetch({
      '/repos/lahaus/subscriptions/installation': () => jsonResponse({ id: 55 }),
      '/app/installations/55/access_tokens': tokenRoute('ghs_55', '2026-08-26T13:00:00Z'),
    })
    const creds = new GitHubAppCredentials({
      appId: '123456',
      privateKey,
      fetch: fn,
      now: () => NOW,
    })
    const scope = { owner: 'lahaus', repo: 'subscriptions' }
    expect(await creds.getToken(scope)).toBe('ghs_55')
    await creds.getToken(scope)
    expect(calls.filter((c) => c.endsWith('/installation')).length).toBe(1)
  })

  it('cae al installationId configurado cuando la app no ve ese repo', async () => {
    // Un 404 del lookup por repo es "la app no cubre ESE repo", no un fallo:
    // tiene que ceder el paso a los otros dos caminos en vez de tirar.
    const { fn } = stubFetch({
      '/repos/ajena/repo/installation': () => new Response('Not Found', { status: 404 }),
      '/app/installations/99/access_tokens': tokenRoute('ghs_default', '2026-08-26T13:00:00Z'),
    })
    const creds = new GitHubAppCredentials({ ...base, fetch: fn, now: () => NOW })
    expect(await creds.getToken({ owner: 'ajena', repo: 'repo' })).toBe('ghs_default')
  })

  it('cae al descubrimiento de instalación única ante un 404 por repo', async () => {
    const { fn } = stubFetch({
      '/repos/ajena/repo/installation': () => new Response('Not Found', { status: 404 }),
      '/app/installations': () => jsonResponse([{ id: 77, account: { login: 'lahaus' } }]),
      '/app/installations/77/access_tokens': tokenRoute('ghs_77', '2026-08-26T13:00:00Z'),
    })
    const creds = new GitHubAppCredentials({
      appId: '123456',
      privateKey,
      fetch: fn,
      now: () => NOW,
    })
    expect(await creds.getToken({ owner: 'ajena', repo: 'repo' })).toBe('ghs_77')
  })

  it('un 500 en el lookup por repo SÍ tira — no es "no aplica"', async () => {
    const { fn } = stubFetch({
      '/repos/acme/demo/installation': () => new Response('boom', { status: 500 }),
    })
    const creds = new GitHubAppCredentials({ ...base, fetch: fn, now: () => NOW })
    expect(creds.getToken({ owner: 'acme', repo: 'demo' })).rejects.toThrow(/500/)
  })

  it('propaga el cuerpo del error de GitHub, no un fallo genérico', async () => {
    const { fn } = stubFetch({
      '/app/installations/99/access_tokens': () =>
        jsonResponse({ message: 'Integration not found' }, 404),
    })
    const creds = new GitHubAppCredentials({ ...base, fetch: fn, now: () => NOW })
    expect(creds.getToken()).rejects.toThrow(/Integration not found/)
  })
})
