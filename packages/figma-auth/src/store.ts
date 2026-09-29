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
  const configDir = env.IA_FLOW_CONFIG_DIR ?? homeConfigDir(env)
  return join(configDir, 'figma-oauth.json')
}

/** Sin HOME **tira**, y no cae al CWD. Un contenedor o un unit de systemd sin
 *  HOME escribiría `./.config/ia-flow/figma-oauth.json` — un refresh token
 *  dentro del working tree, que sobrevive a un `docker cp` o a un tarball
 *  aunque el archivo sea 0600. Que ese deploy tenga que declarar
 *  IA_FLOW_CONFIG_DIR es barato; el token filtrado no. */
function homeConfigDir(env: Record<string, string | undefined>): string {
  const home = env.HOME ?? env.USERPROFILE
  if (!home?.trim()) {
    throw new Error(
      'No hay HOME para resolver dónde guardar la sesión de Figma. ' +
        'Seteá IA_FLOW_CONFIG_DIR (guardarla en el directorio actual dejaría el ' +
        'refresh token en el working tree).',
    )
  }
  return join(home, '.config', 'ia-flow')
}

export class FileTokenStore implements FigmaTokenStore {
  readonly #explicitPath: string | undefined

  constructor(path?: string) {
    this.#explicitPath = path
  }

  /** Perezoso: el composition root construye esta clase al importar, y
   *  resolver el default ahí tiraría en el boot de un proceso sin HOME. Acá el
   *  throw sale por `load()`/`save()`, donde SÍ hay quien lo reporte. */
  get path(): string {
    return this.#explicitPath ?? defaultSessionPath()
  }

  async load(): Promise<FigmaSession | null> {
    const { path } = this
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch (err) {
      // "No hay sesión" es un estado legítimo (nadie corrió el login todavía),
      // no un error: quien llama decide si eso lo bloquea.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }

    try {
      const parsed = JSON.parse(raw) as FigmaSession
      if (!parsed?.tokens?.accessToken || !parsed?.client?.clientId) {
        log.warn({ path: path }, 'la sesión de Figma está incompleta — se ignora')
        return null
      }
      return parsed
    } catch {
      // Un JSON roto se trata como ausencia y no como excepción: el remedio es
      // el mismo (volver a loguearse) y tirar acá frenaría el boot del daemon
      // por una integración opcional.
      log.warn({ path: path }, 'la sesión de Figma no es JSON válido — se ignora')
      return null
    }
  }

  async save(session: FigmaSession): Promise<void> {
    const { path } = this
    await mkdir(dirname(path), { recursive: true })
    // 0600 en el write Y en el chmod: el mode del `writeFile` no aplica a un
    // archivo que ya existía, que es el caso de todo refresh después del
    // primer login.
    await writeFile(path, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 })
    await chmod(path, 0o600)
  }

  async clear(): Promise<void> {
    const { path } = this
    await rm(path, { force: true })
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
