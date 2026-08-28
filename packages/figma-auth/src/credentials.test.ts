import { describe, expect, it } from 'bun:test'
import { FigmaCredentials } from './credentials.js'
import { type FigmaSession, MemoryTokenStore } from './store.js'

const RESOURCE = 'https://mcp.figma.com/.well-known/oauth-protected-resource'
const AS = 'https://api.figma.com/.well-known/oauth-authorization-server'
const TOKEN = 'https://api.figma.com/v1/oauth/token'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function session(expiresAt: number | undefined, refreshToken?: string): FigmaSession {
  return {
    client: { clientId: 'cid' },
    tokens: { accessToken: 'viejo', refreshToken, expiresAt, tokenType: 'Bearer' },
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

/** Descubrimiento + token endpoint, contando las llamadas al refresh. */
function stub(tokenResponse: () => Response) {
  let refreshes = 0
  const doFetch = async (url: string) => {
    if (url === RESOURCE) return json({ authorization_servers: ['https://api.figma.com'] })
    if (url === AS)
      return json({
        issuer: 'https://api.figma.com',
        authorization_endpoint: 'https://www.figma.com/oauth/mcp',
        token_endpoint: TOKEN,
        code_challenge_methods_supported: ['S256'],
      })
    if (url === TOKEN) {
      refreshes++
      return tokenResponse()
    }
    throw new Error(`sin stub para ${url}`)
  }
  return { doFetch, refreshes: () => refreshes }
}

describe('FigmaCredentials', () => {
  it('devuelve el token vigente sin tocar la red', async () => {
    const creds = new FigmaCredentials({
      store: new MemoryTokenStore(session(600_000)),
      staticToken: '',
      now: () => 0,
      fetch: async () => {
        throw new Error('no debería llamar a la red')
      },
    })
    expect(await creds.getToken()).toBe('viejo')
  })

  it('renueva dentro del margen y persiste la sesión nueva', async () => {
    const store = new MemoryTokenStore(session(30_000, 'rt'))
    const { doFetch } = stub(() => json({ access_token: 'nuevo', expires_in: 3600 }))
    const creds = new FigmaCredentials({ store, staticToken: '', now: () => 0, fetch: doFetch })

    // expiresAt (30s) cae dentro del margen de renovación (60s).
    expect(await creds.getToken()).toBe('nuevo')
    const saved = await store.load()
    expect(saved?.tokens.accessToken).toBe('nuevo')
    // El refresh token se conserva para la próxima renovación.
    expect(saved?.tokens.refreshToken).toBe('rt')
  })

  it('N llamadas concurrentes renuevan UNA vez', async () => {
    const { doFetch, refreshes } = stub(() => json({ access_token: 'nuevo', expires_in: 3600 }))
    const creds = new FigmaCredentials({
      store: new MemoryTokenStore(session(0, 'rt')),
      staticToken: '',
      now: () => 0,
      fetch: doFetch,
    })
    const tokens = await Promise.all([creds.getToken(), creds.getToken(), creds.getToken()])
    expect(tokens).toEqual(['nuevo', 'nuevo', 'nuevo'])
    expect(refreshes()).toBe(1)
  })

  it('sin sesión devuelve undefined — no está configurado, no está roto', async () => {
    const creds = new FigmaCredentials({ store: new MemoryTokenStore(null), staticToken: '' })
    expect(await creds.getToken()).toBeUndefined()
    expect(creds.describe().mode).toBe('figma-oauth')
  })

  it('sin sesión cae al token estático del deploy headless', async () => {
    const creds = new FigmaCredentials({
      store: new MemoryTokenStore(null),
      staticToken: 'pegado-a-mano',
    })
    expect(await creds.getToken()).toBe('pegado-a-mano')
    expect(creds.describe().mode).toBe('figma-static')
  })

  it('lee el token estático del env TARDE — el env llega después del container', async () => {
    const creds = new FigmaCredentials({ store: new MemoryTokenStore(null) })
    expect(await creds.getToken()).toBeUndefined()
    // Esto es lo que hace `envRepo.loadIntoProcess()` después de que el
    // composition root ya construyó la credencial.
    Bun.env.FIGMA_MCP_TOKEN = 'llegó-tarde'
    try {
      expect(await creds.getToken()).toBe('llegó-tarde')
    } finally {
      Bun.env.FIGMA_MCP_TOKEN = undefined
    }
  })

  it('re-lee el disco mientras no haya sesión, para tomar un login en caliente', async () => {
    const store = new MemoryTokenStore(null)
    const creds = new FigmaCredentials({ store, staticToken: '', now: () => 0 })
    expect(await creds.getToken()).toBeUndefined()
    await store.save(session(600_000))
    expect(await creds.getToken()).toBe('viejo')
  })

  it('un token vencido sin refresh token degrada — no tumba los otros MCP del agente', async () => {
    const creds = new FigmaCredentials({
      store: new MemoryTokenStore(session(0)),
      staticToken: '',
      now: () => 0,
    })
    expect(await creds.getToken()).toBeUndefined()
  })

  it('un refresh rechazado degrada a undefined y no deja el fallo cacheado', async () => {
    const store = new MemoryTokenStore(session(0, 'rt'))
    let first = true
    const { doFetch } = stub(() => {
      if (first) {
        first = false
        return new Response('invalid_grant', { status: 400 })
      }
      return json({ access_token: 'recuperado', expires_in: 3600 })
    })
    const creds = new FigmaCredentials({ store, staticToken: '', now: () => 0, fetch: doFetch })

    // No tira: quien interpola `${FIGMA_TOKEN}` no envuelve esto en try/catch,
    // y un blip de red mataría el dispatch entero del agente.
    expect(await creds.getToken()).toBeUndefined()
    // La sesión se re-lee: un login nuevo (o un upstream que se recuperó) toma
    // efecto sin reiniciar el daemon.
    expect(await creds.getToken()).toBe('recuperado')
  })
})
