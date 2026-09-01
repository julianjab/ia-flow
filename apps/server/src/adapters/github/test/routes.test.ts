import { afterEach, describe, expect, it } from 'bun:test'
import { setGitHubCredentials } from '@ia-flow/issue-sources'
import type { CredentialDescription } from '@ia-flow/shared'
import { createGithubRouter } from '../routes.js'

// El descubrimiento de owners/repos es lo único de este router que depende de
// CON QUÉ IDENTIDAD corre el daemon, así que el test cablea la credencial y
// espía a qué endpoint de la REST se le pega.

const realFetch = globalThis.fetch

function withCredentials(mode: string) {
  setGitHubCredentials({
    getToken: async () => 'tok',
    describe: (): CredentialDescription => ({ mode }),
  })
}

/** Un provider perezoso: no sabe su modo hasta que alguien le pide un token —
 *  la forma exacta de `lazyGitHubCredentials`, que es lo que cablea el server. */
function withLazyCredentials(mode: string) {
  let resolved = false
  setGitHubCredentials({
    getToken: async () => {
      resolved = true
      return 'tok'
    },
    describe: (): CredentialDescription => (resolved ? { mode } : { mode: 'pending' }),
  })
}

/** Devuelve las rutas pedidas, en orden, y responde lo que diga `routes`. */
function stubGitHub(routes: Record<string, unknown>) {
  const calls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname + new URL(String(input)).search
    calls.push(path)
    const key = Object.keys(routes).find((k) => path.startsWith(k))
    if (!key) {
      return new Response(JSON.stringify({ message: 'Resource not accessible by integration' }), {
        status: 403,
      })
    }
    return new Response(JSON.stringify(routes[key]), { status: 200 })
  }) as typeof fetch
  return calls
}

afterEach(() => {
  globalThis.fetch = realFetch
  // `setGitHubCredentials` es estado de módulo del paquete: sin devolverlo al
  // fallback, cualquier test posterior del proceso hereda esta credencial.
  setGitHubCredentials(null as never)
})

const INSTALLATION = {
  total_count: 2,
  repositories: [
    { name: 'lh-seller-v2-frontend', owner: { login: 'la-haus', type: 'Organization' } },
    { name: 'subscriptions', owner: { login: 'la-haus', type: 'Organization' } },
  ],
}

describe('GET /owners — la identidad decide el endpoint', () => {
  it('una GitHub App pregunta por su instalación, nunca por /user', async () => {
    withCredentials('github-app')
    const calls = stubGitHub({ '/installation/repositories': INSTALLATION })

    const res = await createGithubRouter().request('/owners?refresh=1')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ owners: [{ login: 'la-haus', type: 'org' }] })
    // `/user` con un installation token es 403 — el bug que esto arregla.
    expect(calls.some((c) => c.startsWith('/user'))).toBe(false)
  })

  it('un PAT sigue preguntando por el viewer y sus orgs', async () => {
    withCredentials('static')
    const calls = stubGitHub({
      '/user/orgs': [{ login: 'la-haus' }],
      '/user': { login: 'julianjab' },
    })

    const res = await createGithubRouter().request('/owners?refresh=1')

    expect(await res.json()).toEqual({
      owners: [
        { login: 'julianjab', type: 'user' },
        { login: 'la-haus', type: 'org' },
      ],
    })
    expect(calls.some((c) => c.startsWith('/installation/repositories'))).toBe(false)
  })

  it('un daemon recién booteado resuelve la credencial antes de elegir endpoint', async () => {
    // El provider real es perezoso y se describe `pending` hasta el primer
    // `getToken()`. Ramificar sobre ese "todavía no sé" pegaría a `/user`.
    withLazyCredentials('github-app')
    const calls = stubGitHub({ '/installation/repositories': INSTALLATION })

    const res = await createGithubRouter().request('/owners?refresh=1')

    expect(await res.json()).toEqual({ owners: [{ login: 'la-haus', type: 'org' }] })
    expect(calls.some((c) => c.startsWith('/user'))).toBe(false)
  })
})

describe('GET /repos — la App lista lo que la instalación alcanza', () => {
  it('filtra los repos de la instalación por owner, sin pegarle a /orgs', async () => {
    withCredentials('github-app')
    const calls = stubGitHub({ '/installation/repositories': INSTALLATION })

    const res = await createGithubRouter().request('/repos?owner=la-haus&refresh=1')

    expect(await res.json()).toEqual({ repos: ['lh-seller-v2-frontend', 'subscriptions'] })
    expect(calls.some((c) => c.startsWith('/orgs/'))).toBe(false)
  })

  it('un owner fuera de la instalación devuelve vacío, no un error', async () => {
    withCredentials('github-app')
    stubGitHub({ '/installation/repositories': INSTALLATION })

    const res = await createGithubRouter().request('/repos?owner=julianjab&refresh=1')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ repos: [] })
  })
})
