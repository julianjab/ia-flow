import { describe, expect, it } from 'bun:test'
import { GitHubAuthConfigSchema } from '@ia-flow/shared'
import { createGitHubCredentials, lazyGitHubCredentials } from './factory.js'

const config = (over: Record<string, unknown> = {}) => GitHubAuthConfigSchema.parse(over)

describe('createGitHubCredentials', () => {
  it('modo static usa el PAT', async () => {
    const creds = await createGitHubCredentials(config({ mode: 'static', token: 'ghp_1' }))
    expect(await creds.getToken()).toBe('ghp_1')
    expect(creds.describe().mode).toBe('static')
  })

  it('modo github-app exige la config completa, en vez de fallar en el primer dispatch', async () => {
    expect(createGitHubCredentials(config({ mode: 'github-app', appId: '1' }))).rejects.toThrow(
      /PRIVATE_KEY/,
    )
  })

  it('auto prefiere la GitHub App sobre el PAT', async () => {
    // Quien configuró una App quiere que el daemon corra como el bot, aunque
    // haya un PAT dando vueltas en el env.
    const creds = await createGitHubCredentials(
      config({ appId: '1', privateKey: fakePem(), token: 'ghp_1' }),
    )
    expect(creds.describe().mode).toBe('github-app')
  })

  it('auto prefiere gh sobre el PAT cuando hay sesión abierta', async () => {
    const creds = await createGitHubCredentials(config({ token: 'ghp_1' }), {
      ghRunner: async (cmd) => ({
        code: 0,
        stdout: cmd.includes('token') ? 'gho_gh' : 'julianjab',
        stderr: '',
      }),
    })
    expect(creds.describe()).toEqual({ mode: 'gh-cli', identity: 'julianjab' })
    expect(await creds.getToken()).toBe('gho_gh')
  })

  it('auto cae al PAT cuando no hay ni app ni gh', async () => {
    const creds = await createGitHubCredentials(config({ token: 'ghp_1' }), {
      ghRunner: async () => ({ code: 1, stdout: '', stderr: 'not logged in' }),
    })
    expect(creds.describe().mode).toBe('static')
    expect(await creds.getToken()).toBe('ghp_1')
  })

  it('auto salta una GitHub App con PEM ilegible en vez de frenar todo', async () => {
    // Una key que no se puede leer es una estrategia inusable, igual que no
    // tenerla. Tirar acá dejaría al operador sin las otras dos por un secreto
    // mal pegado.
    const creds = await createGitHubCredentials(
      config({ appId: '1', privateKey: 'no-soy-un-pem', token: 'ghp_1' }),
      { ghRunner: async () => ({ code: 1, stdout: '', stderr: 'not logged in' }) },
    )
    expect(creds.describe().mode).toBe('static')
    expect(await creds.getToken()).toBe('ghp_1')
  })

  it('el modo github-app explícito SÍ tira con un PEM ilegible', async () => {
    // Acá no hay ambigüedad: el operador pidió esta estrategia y sólo esta.
    expect(
      createGitHubCredentials(config({ mode: 'github-app', appId: '1', privateKey: 'basura' })),
    ).rejects.toThrow(/no parece un PEM/)
  })

  it('sin nada configurado devuelve un provider sin token en vez de tirar', async () => {
    // Un throw acá dejaría el server sin arrancar por no poder hablar con
    // GitHub — que es una feature, no un requisito de boot.
    const creds = await createGitHubCredentials(config({ mode: 'static' }))
    expect(await creds.getToken()).toBeUndefined()
  })
})

describe('lazyGitHubCredentials', () => {
  it('no lee la config hasta el primer getToken', async () => {
    // Es lo que permite que el composition root del server se evalúe antes de
    // `envRepo.loadIntoProcess()` sin perderse las vars guardadas en SQLite.
    let reads = 0
    const creds = lazyGitHubCredentials(() => {
      reads++
      return config({ mode: 'static', token: 'ghp_lazy' })
    })
    expect(reads).toBe(0)
    expect(creds.describe()).toEqual({ mode: 'pending' })

    expect(await creds.getToken()).toBe('ghp_lazy')
    expect(reads).toBe(1)
    expect(creds.describe().mode).toBe('static')
  })

  it('reintenta después de un fallo en vez de envenenarse', async () => {
    // Si la promesa rechazada quedara cacheada, corregir un PEM mal pegado
    // desde Settings no arreglaría nada hasta reiniciar el daemon — que es
    // justo lo que este diseño perezoso existe para evitar.
    let broken = true
    const creds = lazyGitHubCredentials(() =>
      broken
        ? config({ mode: 'github-app', appId: '1' })
        : config({ mode: 'static', token: 'ghp_arreglado' }),
    )
    expect(creds.getToken()).rejects.toThrow(/PRIVATE_KEY/)

    broken = false
    expect(await creds.getToken()).toBe('ghp_arreglado')
    expect(creds.describe().mode).toBe('static')
  })

  it('construye una sola estrategia con llamadas concurrentes', async () => {
    let reads = 0
    const creds = lazyGitHubCredentials(() => {
      reads++
      return config({ mode: 'static', token: 'ghp_lazy' })
    })
    await Promise.all([creds.getToken(), creds.getToken(), creds.getToken()])
    expect(reads).toBe(1)
  })
})

/** PEM sintáctico: `auto` sólo mira que la config esté, no firma nada acá. */
function fakePem(): string {
  return '-----BEGIN RSA PRIVATE KEY-----\nZmFrZQ==\n-----END RSA PRIVATE KEY-----'
}
