import { createLogger } from './logger.js'
import {
  FIGMA_MCP_SCOPE,
  type FetchLike,
  type OAuthClient,
  buildAuthorizationUrl,
  discoverAuthServer,
  exchangeCode,
  registerClient,
} from './oauth.js'
import { createPkcePair, randomState } from './pkce.js'
import { type FigmaSession, type FigmaTokenStore, FileTokenStore } from './store.js'

const log = createLogger('figma-auth:login')

/** Puerto fijo por default y no efímero: el redirect URI queda registrado en
 *  el cliente OAuth, así que tiene que ser el mismo en el próximo login o el
 *  cliente guardado deja de servir. */
export const DEFAULT_REDIRECT_PORT = 51789
const CALLBACK_PATH = '/callback'
const TIMEOUT_MS = 5 * 60_000

export interface LoginOptions {
  port?: number
  /** Cliente OAuth propio, para cuando el registro dinámico no está
   *  disponible. Sin esto se registra uno solo. */
  clientId?: string
  clientSecret?: string
  clientName?: string
  store?: FigmaTokenStore
  fetch?: FetchLike
  openBrowser?: boolean
  /** Salida para humanos. Es un parámetro para que el paquete no imponga
   *  `console.log` a quien lo embeba. */
  print?: (msg: string) => void
}

/**
 * Authorization code + PKCE contra el AS de Figma, con el redirect en un
 * listener local efímero.
 *
 * Loopback y no un redirect en la nube porque es lo que el flujo de una CLI
 * puede hacer sin infra: el `code` nunca sale de la máquina del operador, y el
 * listener muere apenas lo recibe.
 */
export async function runFigmaLogin(opts: LoginOptions = {}): Promise<FigmaSession> {
  const print = opts.print ?? ((msg: string) => console.log(msg))
  const port = opts.port ?? DEFAULT_REDIRECT_PORT
  const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`
  const store = opts.store ?? new FileTokenStore()
  const deps = { fetch: opts.fetch }

  const metadata = await discoverAuthServer(deps)
  const client = await resolveClient(opts, metadata, redirectUri, store, print)

  const pkce = createPkcePair()
  const state = randomState()
  const authUrl = buildAuthorizationUrl({
    metadata,
    client,
    redirectUri,
    pkce,
    state,
    scope: FIGMA_MCP_SCOPE,
  })

  const waitForCode = listenForCallback(port, state, print)
  print(`\nAbrí esta URL para autorizar ia-flow en Figma:\n\n  ${authUrl}\n`)
  if (opts.openBrowser !== false) openBrowser(authUrl)

  const code = await waitForCode
  const tokens = await exchangeCode(
    { metadata, client, redirectUri, code, verifier: pkce.verifier },
    deps,
  )

  const session: FigmaSession = { client, tokens, updatedAt: new Date().toISOString() }
  await store.save(session)
  log.info({ clientId: client.clientId, expiresAt: tokens.expiresAt }, 'sesión de Figma guardada')
  return session
}

/**
 * Orden: el cliente que el operador pasó → el que ya quedó guardado de un
 * login anterior → uno nuevo por registro dinámico.
 *
 * Reusar el guardado importa: cada registro crea un cliente OAuth más del lado
 * de Figma, y volver a loguearse no es razón para dejar basura registrada.
 */
async function resolveClient(
  opts: LoginOptions,
  metadata: Awaited<ReturnType<typeof discoverAuthServer>>,
  redirectUri: string,
  store: FigmaTokenStore,
  print: (msg: string) => void,
): Promise<OAuthClient> {
  const explicitId = opts.clientId ?? Bun.env.FIGMA_OAUTH_CLIENT_ID
  if (explicitId) {
    return {
      clientId: explicitId,
      clientSecret: opts.clientSecret ?? Bun.env.FIGMA_OAUTH_CLIENT_SECRET,
    }
  }

  const existing = await store.load()
  if (existing?.client.clientId) {
    print(`Reusando el cliente OAuth ya registrado (${existing.client.clientId}).`)
    return existing.client
  }

  print('Registrando un cliente OAuth nuevo en Figma…')
  return registerClient(
    { metadata, redirectUri, clientName: opts.clientName },
    { fetch: opts.fetch },
  )
}

/** Un solo request y se apaga. Devuelve el `code`; rechaza si el redirect trae
 *  un error, si el `state` no es el nuestro, o si nadie vuelve en 5'. */
function listenForCallback(
  port: number,
  state: string,
  print: (msg: string) => void,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const server = Bun.serve({
      port,
      // Loopback explícito: sin `hostname`, Bun bindea 0.0.0.0 y deja el
      // endpoint que recibe el authorization code abierto a toda la LAN —
      // donde alcanza un GET con state inválido para abortar el login en
      // curso, porque `finish` es único e irreversible.
      hostname: '127.0.0.1',
      fetch(req) {
        const url = new URL(req.url)
        if (url.pathname !== CALLBACK_PATH) return new Response('Not found', { status: 404 })

        const error = url.searchParams.get('error')
        const code = url.searchParams.get('code')
        const got = url.searchParams.get('state')

        if (error) {
          finish(
            new Error(
              `Figma rechazó la autorización: ${error} ${url.searchParams.get('error_description') ?? ''}`.trim(),
            ),
          )
          return page('Autorización rechazada', 'Podés cerrar esta pestaña y mirar la terminal.')
        }
        // El state se compara SIEMPRE, incluso antes de mirar el code: un
        // callback que no originamos nosotros no se canjea.
        if (got !== state) {
          finish(new Error('El state del callback no coincide — se descarta el redirect'))
          return page('Redirect inesperado', 'Volvé a correr el login.')
        }
        if (!code) {
          finish(new Error('El callback de Figma no trajo `code`'))
          return page('Falta el code', 'Volvé a correr el login.')
        }

        finish(null, code)
        return page('Listo', 'ia-flow ya tiene acceso al MCP de Figma. Podés cerrar esta pestaña.')
      },
    })

    const timer = setTimeout(() => {
      finish(new Error(`Nadie completó la autorización en ${TIMEOUT_MS / 60_000} minutos`))
    }, TIMEOUT_MS)

    let done = false
    function finish(err: Error | null, code?: string) {
      if (done) return
      done = true
      clearTimeout(timer)
      // `stop(true)` cierra las conexiones vivas: sin eso el proceso del
      // script queda colgado esperando el keep-alive del browser.
      queueMicrotask(() => server.stop(true))
      if (err) reject(err)
      else resolve(code as string)
    }

    print(`Escuchando el redirect en ${`http://127.0.0.1:${port}${CALLBACK_PATH}`}`)
  })
}

function page(title: string, body: string): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
      `<body style="font-family:system-ui;padding:3rem;max-width:32rem"><h1>${title}</h1><p>${body}</p>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  )
}

/** Abrir el browser es una comodidad, no un requisito: la URL ya se imprimió,
 *  así que un fallo acá no puede frenar el login (headless, WSL, SSH). */
function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin'
      ? ['open', url]
      : process.platform === 'win32'
        ? ['cmd', '/c', 'start', '', url]
        : ['xdg-open', url]
  try {
    Bun.spawn(cmd, { stdout: 'ignore', stderr: 'ignore' })
  } catch {
    // La URL está impresa arriba; que no haya browser no es un error.
  }
}
