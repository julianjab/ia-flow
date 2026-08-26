import { afterEach, describe, expect, it } from 'bun:test'
import { getGitHubToken, setGitHubCredentials } from './credentials.js'

// El módulo guarda estado global (igual que `logger.ts`): cada test que lo
// cablea tiene que devolverlo al fallback de env.
afterEach(() => {
  setGitHubCredentials(null as never)
})

describe('getGitHubToken', () => {
  it('cae a GITHUB_TOKEN sin host cableado', async () => {
    const prev = Bun.env.GITHUB_TOKEN
    Bun.env.GITHUB_TOKEN = 'ghp_env'
    expect(await getGitHubToken()).toBe('ghp_env')
    Bun.env.GITHUB_TOKEN = prev
  })

  it('usa el provider cableado por el host', async () => {
    setGitHubCredentials({
      getToken: async () => 'ghs_app',
      describe: () => ({ mode: 'github-app' }),
    })
    expect(await getGitHubToken()).toBe('ghs_app')
  })

  it('pregunta de nuevo en cada llamada — no cachea el valor', async () => {
    // Es el punto del indirección: un installation token rota y `gql`/`rest`
    // tienen que ver el nuevo sin reiniciar el proceso.
    let n = 0
    setGitHubCredentials({
      getToken: async () => `ghs_${++n}`,
      describe: () => ({ mode: 'github-app' }),
    })
    expect(await getGitHubToken()).toBe('ghs_1')
    expect(await getGitHubToken()).toBe('ghs_2')
  })

  it('propaga el scope para que una app multi-org elija la instalación', async () => {
    let seen: unknown
    setGitHubCredentials({
      getToken: async (scope) => {
        seen = scope
        return 'ghs_x'
      },
      describe: () => ({ mode: 'github-app' }),
    })
    await getGitHubToken({ owner: 'lahaus', repo: 'subscriptions' })
    expect(seen).toEqual({ owner: 'lahaus', repo: 'subscriptions' })
  })
})
