import type { CredentialDescription, ICredentialProvider } from '@ia-flow/shared'
import { createLogger } from './logger.js'

const log = createLogger('github-auth:gh-cli')

/** Cuánto vale un token de `gh` antes de volver a preguntarle. No es la vida
 *  del token (la maneja `gh`): es cuánto toleramos no enterarnos de un
 *  `gh auth logout` o de un cambio de cuenta. */
const CACHE_TTL_MS = 60_000

export type CommandRunner = (
  cmd: string[],
) => Promise<{ code: number; stdout: string; stderr: string }>

const bunRunner: CommandRunner = async (cmd) => {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr }
}

/**
 * El "login de GitHub" barato: delega en el `gh` CLI que el operador ya tiene
 * autenticado en su máquina.
 *
 * No implementa OAuth ni persiste nada — `gh` ya hizo el device flow, ya
 * guarda el refresh token y ya lo renueva. Cubre el caso "quiero que esto
 * corra con MI usuario en local" sin una línea de OAuth ni una app registrada,
 * que es la razón por la que existe en vez de saltar directo al device flow.
 *
 * Contrapartida: la identidad es una persona, no un bot. Para un daemon que
 * corre desatendido querés `github-app`.
 */
export class GhCliCredentials implements ICredentialProvider {
  readonly #run: CommandRunner
  #cached: { token: string; at: number } | null = null
  #login: string | undefined

  constructor(opts: { run?: CommandRunner } = {}) {
    this.#run = opts.run ?? bunRunner
  }

  async getToken(): Promise<string | undefined> {
    const now = Date.now()
    if (this.#cached && now - this.#cached.at < CACHE_TTL_MS) return this.#cached.token

    const res = await this.#run(['gh', 'auth', 'token']).catch((err) => ({
      code: 127,
      stdout: '',
      stderr: String(err),
    }))
    const token = res.stdout.trim()
    if (res.code !== 0 || !token) {
      // Fail-open hacia "sin credencial", no hacia una excepción: el caller ya
      // sabe qué hacer sin token (un repo público clona igual), y en `auto`
      // esto es simplemente la señal de que gh no está disponible.
      log.warn(
        { code: res.code, stderr: res.stderr.trim().slice(0, 200) },
        'gh auth token falló — sin credencial por esta vía',
      )
      this.#cached = null
      return undefined
    }
    this.#cached = { token, at: now }
    return token
  }

  describe(): CredentialDescription {
    return { mode: 'gh-cli', identity: this.#login }
  }

  /**
   * Login del usuario autenticado, para mostrar en la UI y en el log del boot.
   * Va aparte de `getToken` porque cuesta un proceso extra y a nadie le
   * bloquea el trabajo: se llama una vez al arrancar, no por request.
   */
  async probeIdentity(): Promise<string | undefined> {
    const res = await this.#run(['gh', 'api', 'user', '--jq', '.login']).catch(() => null)
    if (!res || res.code !== 0) return undefined
    this.#login = res.stdout.trim() || undefined
    return this.#login
  }

  /** ¿Hay un `gh` autenticado en esta máquina? Lo usa `auto` para decidir. */
  async isAvailable(): Promise<boolean> {
    return (await this.getToken()) !== undefined
  }
}
