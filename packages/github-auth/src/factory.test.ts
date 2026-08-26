import { describe, expect, it } from 'bun:test'
import { GitHubAuthConfigSchema } from '@ia-flow/shared'
import { configVarsForMode, createGitHubCredentials, lazyGitHubCredentials } from './factory.js'

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

  it('auto prefiere el PAT configurado sobre el gh de la máquina', async () => {
    // Sin esto, un host que hoy corre con GITHUB_TOKEN y encima tiene un `gh`
    // logueado pasaría a comentar y pushear como ese humano sin que nadie
    // tocara config: un cambio de identidad silencioso.
    const creds = await createGitHubCredentials(config({ token: 'ghp_1' }), {
      ghRunner: async () => ({ code: 0, stdout: 'gho_gh', stderr: '' }),
    })
    expect(creds.describe().mode).toBe('static')
    expect(await creds.getToken()).toBe('ghp_1')
  })

  it('auto usa gh sólo cuando no hay nada configurado en ia-flow', async () => {
    const creds = await createGitHubCredentials(config({}), {
      ghRunner: async (cmd) => ({
        code: 0,
        stdout: cmd.includes('token') ? 'gho_gh' : 'julianjab',
        stderr: '',
      }),
    })
    expect(creds.describe()).toEqual({ mode: 'gh-cli', identity: 'julianjab' })
    expect(await creds.getToken()).toBe('gho_gh')
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

  it('reset() relee la config y vuelve a elegir estrategia', async () => {
    // El caso de una instalación limpia: el daemon arranca sin credenciales,
    // `auto` resuelve a un provider sin token y lo cachea. Sin reset, pegar el
    // PAT en Settings no hace nada hasta reiniciar el proceso.
    const env: { token?: string } = {}
    const creds = lazyGitHubCredentials(() => config({ mode: 'static', token: env.token }))
    expect(await creds.getToken()).toBeUndefined()

    env.token = 'ghp_recien_pegado'
    expect(await creds.getToken()).toBeUndefined()

    creds.reset()
    expect(await creds.getToken()).toBe('ghp_recien_pegado')
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

describe('configVarsForMode — qué campos ofrece Configuración', () => {
  it('en github-app no ofrece el PAT', () => {
    // El caso que motivó el catálogo declarativo: pedirle un PAT a un daemon
    // que corre como App es un campo que no hace nada, y el operador no tiene
    // cómo saberlo.
    const vars = configVarsForMode('github-app')
    expect(vars).not.toContain('GITHUB_TOKEN')
    expect(vars).toContain('IA_FLOW_GITHUB_APP_ID')
    expect(vars).toContain('IA_FLOW_GITHUB_APP_PRIVATE_KEY_PATH')
  })

  it('en static no ofrece las de la App', () => {
    const vars = configVarsForMode('static')
    expect(vars).toContain('GITHUB_TOKEN')
    expect(vars.filter((v) => v.includes('APP'))).toEqual([])
  })

  it('en gh-cli no ofrece ninguna credencial — su config vive fuera de ia-flow', () => {
    expect(configVarsForMode('gh-cli')).toEqual(['IA_FLOW_GITHUB_AUTH_MODE'])
  })

  it('en auto las ofrece todas', () => {
    // `auto` prueba app → PAT → gh. Esconder el campo que hace falta completar
    // para que la cadena elija otra cosa sería al revés de lo útil.
    const vars = configVarsForMode('auto')
    expect(vars).toContain('GITHUB_TOKEN')
    expect(vars).toContain('IA_FLOW_GITHUB_APP_ID')
  })

  it('el selector de modo siempre está — es lo que decide todo lo demás', () => {
    for (const mode of ['auto', 'static', 'gh-cli', 'github-app']) {
      expect(configVarsForMode(mode)).toContain('IA_FLOW_GITHUB_AUTH_MODE')
    }
  })
})
