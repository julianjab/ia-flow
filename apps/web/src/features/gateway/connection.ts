// Los gateways que esta consola conoce, y cuál está mirando.
//
// Es el equivalente de `features/servers/selection.ts` para el otro proceso,
// con una diferencia: no hay un "server proxeado" por default del que colgarse
// — un gateway es siempre una URL explícita, y desde que un agente puede
// ofertar a un pool (`remote:*`) suele haber varios. Por eso esto guarda una
// LISTA, no una elección suelta: cambiar de máquina no puede costar re-tipear
// la URL y el token cada vez.
//
// El token vive acá y no en el server a propósito: `GET /api/provider-
// registrations` lo redacta (`toPublicRegistration` devuelve `hasToken`, no el
// valor). Es del operador, y se queda en el localStorage de este origen.

const LIST_KEY = 'ia-flow:gateway:list'
const SELECTED_KEY = 'ia-flow:gateway:url'
/** Clave de la pantalla vieja (y la que escribe el preload de Electron). Se
 *  lee para migrar y para tomar el token que la app inyecta al abrir. */
const LEGACY_TOKEN_KEY = 'ia-flow:gateway:token'

export const DEFAULT_GATEWAY_URL = 'http://localhost:3002'

export interface GatewayEntry {
  url: string
  token: string
}

/** Sin barra final: todas las rutas se concatenan como `${base}/v1/...`. */
export function normalizeGatewayUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '')
}

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    // Storage bloqueado (modo privado, política del browser): la consola cae
    // a los defaults y pide el token en pantalla, como si fuera la primera vez.
    return null
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value) window.localStorage.setItem(key, value)
    else window.localStorage.removeItem(key)
  } catch {
    // Ídem: no poder recordar no es motivo para no funcionar en esta sesión.
  }
}

function parseList(raw: string | null): GatewayEntry[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((e): e is GatewayEntry => !!e && typeof e.url === 'string')
      .map((e) => ({ url: normalizeGatewayUrl(e.url), token: String(e.token ?? '') }))
      .filter((e) => e.url)
  } catch {
    // Un JSON roto no puede dejar la consola inservible: se descarta y la
    // próxima escritura lo deja sano.
    return []
  }
}

export function listGateways(): GatewayEntry[] {
  return parseList(read(LIST_KEY))
}

function saveList(entries: GatewayEntry[]): void {
  write(LIST_KEY, entries.length ? JSON.stringify(entries) : null)
}

/**
 * Da de alta (o actualiza) un gateway y lo deja como el seleccionado.
 *
 * Un token vacío NO pisa el guardado: el preload de Electron escribe el token
 * del gateway local, y reconectar desde la barra sin re-tipearlo no debería
 * borrarlo.
 */
export function upsertGateway(url: string, token: string): GatewayEntry {
  const normalized = normalizeGatewayUrl(url)
  const entries = listGateways()
  const existing = entries.find((e) => e.url === normalized)
  const entry: GatewayEntry = { url: normalized, token: token.trim() || (existing?.token ?? '') }
  saveList([entry, ...entries.filter((e) => e.url !== normalized)])
  write(SELECTED_KEY, normalized)
  return entry
}

export function removeGateway(url: string): void {
  const normalized = normalizeGatewayUrl(url)
  const rest = listGateways().filter((e) => e.url !== normalized)
  saveList(rest)
  if (read(SELECTED_KEY) === normalized) write(SELECTED_KEY, rest[0]?.url ?? null)
}

export function selectGateway(url: string): void {
  write(SELECTED_KEY, normalizeGatewayUrl(url))
}

/**
 * El gateway que la consola debe abrir, y su token.
 *
 * Orden: el `?url=` de la query (lo pone la app de Electron, que sabe en qué
 * puerto levantó el suyo), el último seleccionado, el primero de la lista, y
 * por último el default. Se da de alta en el momento para que un `?url=`
 * nuevo quede en la lista y se pueda volver a elegir sin tipearlo.
 */
export function resolveGateway(): GatewayEntry {
  migrateLegacy()
  const fromQuery = new URLSearchParams(window.location.search).get('url')
  const entries = listGateways()
  const chosen =
    (fromQuery && normalizeGatewayUrl(fromQuery)) ||
    read(SELECTED_KEY) ||
    entries[0]?.url ||
    DEFAULT_GATEWAY_URL
  const normalized = normalizeGatewayUrl(chosen)
  const known = entries.find((e) => e.url === normalized)
  // El preload escribe el token en la clave legacy justo antes de que cargue
  // la página: si el elegido todavía no tiene uno propio, ese es el suyo.
  return upsertGateway(normalized, known?.token || (read(LEGACY_TOKEN_KEY) ?? ''))
}

/** La pantalla vieja guardaba UNA url y UN token sueltos. Se convierten en la
 *  primera entrada de la lista para no perder lo que ya estaba configurado. */
function migrateLegacy(): void {
  if (read(LIST_KEY)) return
  const url = read(SELECTED_KEY)
  const token = read(LEGACY_TOKEN_KEY)
  if (!url && !token) return
  saveList([{ url: normalizeGatewayUrl(url ?? DEFAULT_GATEWAY_URL), token: token ?? '' }])
}
