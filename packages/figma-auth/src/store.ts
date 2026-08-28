import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createLogger } from './logger.js'
import type { OAuthClient, TokenSet } from './oauth.js'

const log = createLogger('figma-auth:store')

export interface FigmaSession {
  client: OAuthClient
  tokens: TokenSet
  /** ISO. Documental: para que quien abra el archivo sepa de cuándo es. */
  updatedAt: string
}

export interface FigmaTokenStore {
  load(): Promise<FigmaSession | null>
  save(session: FigmaSession): Promise<void>
  clear(): Promise<void>
}

/**
 * `~/.config/ia-flow/figma-oauth.json` (o lo que diga `IA_FLOW_CONFIG_DIR`).
 *
 * Un archivo y no la tabla de env vars por dos razones: lo escribe un script
 * de CLI que corre en otro proceso que el daemon —y abrir la SQLite del daemon
 * para eso es pedir un lock que no necesitamos—, y un refresh token no es
 * config que alguien edita a mano en un textarea de Settings.
 */
export function defaultSessionPath(env: Record<string, string | undefined> = Bun.env): string {
  const home = env.HOME ?? env.USERPROFILE ?? '.'
  const configDir = env.IA_FLOW_CONFIG_DIR ?? join(home, '.config', 'ia-flow')
  return join(configDir, 'figma-oauth.json')
}

export class FileTokenStore implements FigmaTokenStore {
  readonly #path: string

  constructor(path: string = defaultSessionPath()) {
    this.#path = path
  }

  get path(): string {
    return this.#path
  }

  async load(): Promise<FigmaSession | null> {
    let raw: string
    try {
      raw = await readFile(this.#path, 'utf8')
    } catch (err) {
      // "No hay sesión" es un estado legítimo (nadie corrió el login todavía),
      // no un error: quien llama decide si eso lo bloquea.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }

    try {
      const parsed = JSON.parse(raw) as FigmaSession
      if (!parsed?.tokens?.accessToken || !parsed?.client?.clientId) {
        log.warn({ path: this.#path }, 'la sesión de Figma está incompleta — se ignora')
        return null
      }
      return parsed
    } catch {
      // Un JSON roto se trata como ausencia y no como excepción: el remedio es
      // el mismo (volver a loguearse) y tirar acá frenaría el boot del daemon
      // por una integración opcional.
      log.warn({ path: this.#path }, 'la sesión de Figma no es JSON válido — se ignora')
      return null
    }
  }

  async save(session: FigmaSession): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true })
    // 0600 en el write Y en el chmod: el mode del `writeFile` no aplica a un
    // archivo que ya existía, que es el caso de todo refresh después del
    // primer login.
    await writeFile(this.#path, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 })
    await chmod(this.#path, 0o600)
  }

  async clear(): Promise<void> {
    await rm(this.#path, { force: true })
  }
}

/** Para tests y para un login que no quiere tocar el disco. */
export class MemoryTokenStore implements FigmaTokenStore {
  #session: FigmaSession | null

  constructor(session: FigmaSession | null = null) {
    this.#session = session
  }

  async load(): Promise<FigmaSession | null> {
    return this.#session
  }

  async save(session: FigmaSession): Promise<void> {
    this.#session = session
  }

  async clear(): Promise<void> {
    this.#session = null
  }
}
