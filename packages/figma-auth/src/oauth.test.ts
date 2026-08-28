import { describe, expect, it } from 'bun:test'
import {
  type AuthServerMetadata,
  FIGMA_MCP_URL,
  buildAuthorizationUrl,
  discoverAuthServer,
  exchangeCode,
  refreshAccessToken,
  registerClient,
} from './oauth.js'

const METADATA: AuthServerMetadata = {
  issuer: 'https://api.figma.com',
  authorization_endpoint: 'https://www.figma.com/oauth/mcp',
  token_endpoint: 'https://api.figma.com/v1/oauth/token',
  registration_endpoint: 'https://api.figma.com/v1/oauth/mcp/register',
  code_challenge_methods_supported: ['S256'],
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** Graba las llamadas y responde por URL. */
function stubFetch(routes: Record<string, () => Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const doFetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const route = routes[url]
    if (!route) throw new Error(`sin stub para ${url}`)
    return route()
  }
  return { doFetch, calls }
}

describe('discoverAuthServer', () => {
  const RESOURCE = 'https://mcp.figma.com/.well-known/oauth-protected-resource'
  const AS = 'https://api.figma.com/.well-known/oauth-authorization-server'

  it('sigue los dos saltos: recurso → authorization server', async () => {
    const { doFetch, calls } = stubFetch({
      [RESOURCE]: () => json({ authorization_servers: ['https://api.figma.com'] }),
      [AS]: () => json(METADATA),
    })
    const metadata = await discoverAuthServer({ fetch: doFetch })
    expect(metadata.token_endpoint).toBe(METADATA.token_endpoint)
    expect(calls.map((c) => c.url)).toEqual([RESOURCE, AS])
  })

  it('falla si el AS dejara de soportar PKCE S256, en vez de caer a plain', async () => {
    const { doFetch } = stubFetch({
      [RESOURCE]: () => json({ authorization_servers: ['https://api.figma.com'] }),
      [AS]: () => json({ ...METADATA, code_challenge_methods_supported: ['plain'] }),
    })
    expect(discoverAuthServer({ fetch: doFetch })).rejects.toThrow(/S256/)
  })

  it('falla con un mensaje accionable si el recurso no declara AS', async () => {
    const { doFetch } = stubFetch({ [RESOURCE]: () => json({}) })
    expect(discoverAuthServer({ fetch: doFetch })).rejects.toThrow(/authorization server/)
  })
})

describe('buildAuthorizationUrl', () => {
  it('lleva PKCE, state y el resource del MCP', () => {
    const url = new URL(
      buildAuthorizationUrl({
        metadata: METADATA,
        client: { clientId: 'cid' },
        redirectUri: 'http://127.0.0.1:51789/callback',
        pkce: { verifier: 'v', challenge: 'chal', method: 'S256' },
        state: 'st4te',
      }),
    )
    expect(url.origin + url.pathname).toBe('https://www.figma.com/oauth/mcp')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_id')).toBe('cid')
    expect(url.searchParams.get('code_challenge')).toBe('chal')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('state')).toBe('st4te')
    expect(url.searchParams.get('scope')).toBe('mcp:connect')
    // RFC 8707: ata el token a ESTE recurso.
    expect(url.searchParams.get('resource')).toBe(FIGMA_MCP_URL)
    // El verifier NUNCA viaja en el authorize.
    expect(url.search).not.toContain('code_verifier')
  })
})

describe('exchangeCode', () => {
  it('manda el verifier y calcula expiresAt contra el reloj inyectado', async () => {
    const { doFetch, calls } = stubFetch({
      [METADATA.token_endpoint]: () =>
        json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, token_type: 'Bearer' }),
    })
    const tokens = await exchangeCode(
      {
        metadata: METADATA,
        client: { clientId: 'cid', clientSecret: 'shh' },
        redirectUri: 'http://127.0.0.1:51789/callback',
        code: 'the-code',
        verifier: 'the-verifier',
      },
      { fetch: doFetch, now: () => 1_000 },
    )

    expect(tokens.accessToken).toBe('at')
    expect(tokens.expiresAt).toBe(1_000 + 3600 * 1000)

    const body = new URLSearchParams(String(calls[0].init?.body))
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code_verifier')).toBe('the-verifier')
    expect(body.get('client_id')).toBe('cid')
    expect(body.get('client_secret')).toBe('shh')
    expect(body.get('resource')).toBe(FIGMA_MCP_URL)
  })

  it('un cliente público no manda client_secret', async () => {
    const { doFetch, calls } = stubFetch({
      [METADATA.token_endpoint]: () => json({ access_token: 'at' }),
    })
    await exchangeCode(
      {
        metadata: METADATA,
        client: { clientId: 'cid' },
        redirectUri: 'http://127.0.0.1:51789/callback',
        code: 'c',
        verifier: 'v',
      },
      { fetch: doFetch },
    )
    const body = new URLSearchParams(String(calls[0].init?.body))
    expect(body.has('client_secret')).toBe(false)
  })

  it('sin expires_in no inventa vencimiento', async () => {
    const { doFetch } = stubFetch({
      [METADATA.token_endpoint]: () => json({ access_token: 'at' }),
    })
    const tokens = await exchangeCode(
      {
        metadata: METADATA,
        client: { clientId: 'cid' },
        redirectUri: 'r',
        code: 'c',
        verifier: 'v',
      },
      { fetch: doFetch },
    )
    expect(tokens.expiresAt).toBeUndefined()
    expect(tokens.tokenType).toBe('Bearer')
  })

  it('el error del token endpoint incluye status y cuerpo', async () => {
    const { doFetch } = stubFetch({
      [METADATA.token_endpoint]: () => new Response('bad verifier', { status: 400 }),
    })
    expect(
      exchangeCode(
        {
          metadata: METADATA,
          client: { clientId: 'c' },
          redirectUri: 'r',
          code: 'c',
          verifier: 'v',
        },
        { fetch: doFetch },
      ),
    ).rejects.toThrow(/400: bad verifier/)
  })
})

describe('refreshAccessToken', () => {
  it('conserva el refresh token viejo cuando la respuesta no trae uno nuevo', async () => {
    const { doFetch } = stubFetch({
      [METADATA.token_endpoint]: () => json({ access_token: 'at2', expires_in: 60 }),
    })
    const tokens = await refreshAccessToken(
      { metadata: METADATA, client: { clientId: 'cid' }, refreshToken: 'rt-viejo' },
      { fetch: doFetch, now: () => 0 },
    )
    expect(tokens.accessToken).toBe('at2')
    expect(tokens.refreshToken).toBe('rt-viejo')
  })

  it('usa el nuevo cuando el AS rota el refresh token', async () => {
    const { doFetch } = stubFetch({
      [METADATA.token_endpoint]: () => json({ access_token: 'at2', refresh_token: 'rt-nuevo' }),
    })
    const tokens = await refreshAccessToken(
      { metadata: METADATA, client: { clientId: 'cid' }, refreshToken: 'rt-viejo' },
      { fetch: doFetch },
    )
    expect(tokens.refreshToken).toBe('rt-nuevo')
  })
})

describe('registerClient', () => {
  it('registra con el redirect propio y devuelve el par id/secret', async () => {
    const { doFetch, calls } = stubFetch({
      [METADATA.registration_endpoint as string]: () =>
        json({ client_id: 'nuevo', client_secret: 'sec' }, 201),
    })
    const client = await registerClient(
      { metadata: METADATA, redirectUri: 'http://127.0.0.1:51789/callback' },
      { fetch: doFetch },
    )
    expect(client).toEqual({ clientId: 'nuevo', clientSecret: 'sec' })
    const body = JSON.parse(String(calls[0].init?.body))
    expect(body.redirect_uris).toEqual(['http://127.0.0.1:51789/callback'])
    expect(body.grant_types).toContain('refresh_token')
  })

  it('si Figma lo rechaza, el error dice cómo seguir a mano', async () => {
    const { doFetch } = stubFetch({
      [METADATA.registration_endpoint as string]: () => new Response('Forbidden', { status: 403 }),
    })
    expect(
      registerClient(
        { metadata: METADATA, redirectUri: 'http://127.0.0.1:51789/callback' },
        { fetch: doFetch },
      ),
    ).rejects.toThrow(/FIGMA_OAUTH_CLIENT_ID/)
  })

  it('sin registration_endpoint no adivina una URL', async () => {
    const { registration_endpoint, ...sinRegistro } = METADATA
    expect(
      registerClient({ metadata: sinRegistro, redirectUri: 'r' }, { fetch: async () => json({}) }),
    ).rejects.toThrow(/registro dinámico/)
  })
})
