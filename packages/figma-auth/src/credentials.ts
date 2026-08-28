import type { CredentialDescription, ICredentialProvider } from '@ia-flow/shared'
import { createLogger } from './logger.js'
import {
  type AuthServerMetadata,
  type OAuthDeps,
  type TokenSet,
  discoverAuthServer,
  refreshAccessToken,
} from './oauth.js'
import { type FigmaSession, type FigmaTokenStore, FileTokenStore } from './store.js'

const log = createLogger('figma-auth')

/** Margen de renovación. Figma emite access tokens cortos; renovar un minuto
 *  antes cubre el clock skew y el run que agarró el token justo en el filo. */
const RENEW_MARGIN_MS = 60_000

/** Escape hatch para un deploy headless que no puede correr un browser: se
 *  pega un token ya obtenido y listo. No se renueva solo — es exactamente el
 *  mismo trato que un PAT. */
export const STATIC_TOKEN_VAR = 'FIGMA_MCP_TOKEN'

/**
 * La credencial del MCP de Figma, detrás del mismo contrato que la de GitHub.
 *
 * Vale la misma regla que hizo falta escribir para los installation tokens:
 * **el token se resuelve por uso, nunca se captura**. Un access token de OAuth
 * vive minutos y el daemon vive días; quien guarde el string en un constructor
 * va a mandar un token vencido y a comerse un 401 del MCP sin saber por qué.
 * Por eso el consumidor es `setSecretResolver`, que llama a `getToken()` en
 * cada expansión de `${FIGMA_TOKEN}`.
 */
export class FigmaCredentials implements ICredentialProvider {
  readonly #store: FigmaTokenStore
  readonly #deps: OAuthDeps
  readonly #now: () => number
  readonly #staticToken: string | undefined

  /** La sesión cargada. `null` significa "no hay archivo", y se reintenta la
   *  lectura en la próxima llamada: así un login hecho con el daemon prendido
   *  se toma sin reiniciarlo. */
  #session: FigmaSession | null = null
  #metadata: Promise<AuthServerMetadata> | null = null
  #refreshing: Promise<string | undefined> | null = null

  constructor(
    opts: {
      store?: FigmaTokenStore
      /** Explícito para tests. En producción se lee del env **tarde** — ver
       *  `#static()`. */
      staticToken?: string
    } & OAuthDeps = {},
  ) {
    this.#store = opts.store ?? new FileTokenStore()
    this.#deps = { fetch: opts.fetch, now: opts.now }
    this.#now = opts.now ?? (() => Date.now())
    this.#staticToken = opts.staticToken
  }

  /**
   * Leer la sesión tampoco puede tirar. `FileTokenStore.load()` traga el
   * ENOENT (nadie se logueó todavía) pero re-lanza cualquier otro error de fs
   * —EACCES, un directorio en vez de un archivo, un HOME que no existe—, y por
   * el mismo camino que el refresh: `setSecretResolver` →
   * `interpolateMcpServers`, sin try/catch en el medio.
   */
  async #load(): Promise<FigmaSession | null> {
    try {
      return await this.#store.load()
    } catch (err) {
      log.error(
        { error: err instanceof Error ? err.message : String(err) },
        'no se pudo leer la sesión de Figma',
      )
      return null
    }
  }

  /**
   * El env se lee en cada llamada, no en el constructor: en `apps/server` las
   * variables guardadas en SQLite entran al proceso recién en
   * `envRepo.loadIntoProcess()`, **después** de que el container se evalúa.
   * Capturarlo arriba vería siempre vacío el campo que alguien acaba de
   * guardar en Settings.
   */
  #static(): string | undefined {
    return (this.#staticToken ?? Bun.env[STATIC_TOKEN_VAR])?.trim() || undefined
  }

  async getToken(): Promise<string | undefined> {
    const session = (this.#session ??= await this.#load())
    if (!session) return this.#static()

    if (!this.#expired(session.tokens)) return session.tokens.accessToken

    // Renovación en vuelo compartida: N runs que arrancan juntos piden UN
    // token, no N. Mismo dedupe que `GitHubAppCredentials`.
    this.#refreshing ??= this.#renew(session).finally(() => {
      this.#refreshing = null
    })
    return this.#refreshing
  }

  describe(): CredentialDescription {
    if (this.#session) return { mode: 'figma-oauth', identity: this.#session.client.clientId }
    if (this.#static()) return { mode: 'figma-static', identity: 'static-token' }
    return { mode: 'figma-oauth' }
  }

  /** Sin `expiresAt` el token se usa hasta que el server lo rechace: inventar
   *  un vencimiento renovaría de más, y no renovar nunca es lo que el AS
   *  pidió al no declarar uno. */
  #expired(tokens: TokenSet): boolean {
    return tokens.expiresAt !== undefined && tokens.expiresAt - RENEW_MARGIN_MS <= this.#now()
  }

  async #renew(session: FigmaSession): Promise<string | undefined> {
    // Un token vencido sin refresh token no se arregla solo, pero degradar
    // sigue siendo mejor que tirar: el throw salía por `getToken()` →
    // `setSecretResolver` → `interpolateMcpServers`, que no lo envuelve, así
    // que un agente con `${GITHUB_TOKEN}` y `${FIGMA_TOKEN}` fallaba TODOS sus
    // dispatches —con su `onError` moviendo el issue y comentando un fallo que
    // nunca se intentó— aunque el MCP de GitHub estuviera sano.
    //
    // El único nivel que puede acotar el daño a un MCP es el que sabe cuál es,
    // y ese no es este. Acá se reporta y se sigue.
    if (!session.tokens.refreshToken) {
      log.error(
        {},
        'el access token de Figma venció y la sesión no tiene refresh token — corré `bun run auth:figma`',
      )
      return undefined
    }

    let tokens: TokenSet
    try {
      // El descubrimiento va DENTRO del try: también habla por red, así que
      // dejarlo afuera reintroducía por la puerta de atrás el throw que el
      // catch existe para evitar — y peor, `??=` dejaba guardada la promesa
      // rechazada, envenenando todo `getToken()` posterior hasta reiniciar el
      // daemon (ni un `auth:figma` nuevo lo arreglaba).
      this.#metadata ??= discoverAuthServer(this.#deps)
      const metadata = await this.#metadata

      tokens = await refreshAccessToken(
        { metadata, client: session.client, refreshToken: session.tokens.refreshToken },
        this.#deps,
      )
    } catch (err) {
      // El metadata no se cachea si la renovación falló por su culpa (un AS
      // que se movió), y la sesión se re-lee del disco: puede que el operador
      // ya haya corrido el login de nuevo.
      this.#metadata = null
      this.#session = null
      // Degrada en vez de tirar. Quien consume esto es la interpolación de
      // `${FIGMA_TOKEN}` en la config de MCP (`agent-engine`), que NO la
      // envuelve en try/catch: un blip de red contra api.figma.com haría
      // fallar el dispatch entero del agente —con sus otros MCP sanos— en vez
      // de dejar sin token al único que lo necesita. Es el mismo criterio
      // fail-open de `canAccept`: un chequeo roto que congela el pipeline es
      // peor que intentar, porque el fallo del run sí se reporta.
      //
      // El error se loguea en `error` con la salida escrita: sin token el MCP
      // contesta 401, y ese log es lo que explica por qué.
      log.error(
        { error: err instanceof Error ? err.message : String(err) },
        'no se pudo renovar el token de Figma — si el refresh token fue revocado, corré `bun run auth:figma`',
      )
      return undefined
    }

    const renewed: FigmaSession = {
      ...session,
      tokens,
      updatedAt: new Date(this.#now()).toISOString(),
    }
    this.#session = renewed
    await this.#store.save(renewed)
    log.info({ expiresAt: tokens.expiresAt }, 'token de Figma renovado')
    return tokens.accessToken
  }
}
