// Los agent-hosts que esta consola conoce, y cuál está mirando.
//
// Es el equivalente de `features/servers/selection.ts` para el otro proceso,
// con una diferencia: no hay un "server proxeado" por default del que colgarse
// — un agent-host es siempre una URL explícita, y desde que un agente puede
// ofertar a un pool (`remote:*`) suele haber varios. Por eso esto guarda una
// LISTA, no una elección suelta: cambiar de máquina no puede costar re-tipear
// la URL y el token cada vez.
//
// El token vive acá y no en el server a propósito: `GET /api/provider-
// registrations` lo redacta (`toPublicRegistration` devuelve `hasToken`, no el
// valor). Es del operador, y se queda en el localStorage de este origen.

const LIST_KEY = 'ia-flow:agent-host:list'
const SELECTED_KEY = 'ia-flow:agent-host:url'

export const DEFAULT_AGENT_HOST_URL = 'http://localhost:3002'

export interface AgentHostEntry {
  url: string
  token: string
}

/** Sin barra final: todas las rutas se concatenan como `${base}/v1/...`. */
export function normalizeAgentHostUrl(raw: string): string {
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

function parseList(raw: string | null): AgentHostEntry[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((e): e is AgentHostEntry => !!e && typeof e.url === 'string')
      .map((e) => ({ url: normalizeAgentHostUrl(e.url), token: String(e.token ?? '') }))
      .filter((e) => e.url)
  } catch {
    // Un JSON roto no puede dejar la consola inservible: se descarta y la
    // próxima escritura lo deja sano.
    return []
  }
}

export function listAgentHosts(): AgentHostEntry[] {
  return parseList(read(LIST_KEY))
}

function saveList(entries: AgentHostEntry[]): void {
  write(LIST_KEY, entries.length ? JSON.stringify(entries) : null)
}

/**
 * Da de alta (o actualiza) un agent-host y lo deja como el seleccionado.
 *
 * Un token vacío NO pisa el guardado: reconectar desde la barra sin volver a
 * tipear el token no debería borrarlo.
 */
export function upsertAgentHost(url: string, token: string): AgentHostEntry {
  const normalized = normalizeAgentHostUrl(url)
  const entries = listAgentHosts()
  const existing = entries.find((e) => e.url === normalized)
  const entry: AgentHostEntry = { url: normalized, token: token.trim() || (existing?.token ?? '') }
  saveList([entry, ...entries.filter((e) => e.url !== normalized)])
  write(SELECTED_KEY, normalized)
  return entry
}

export function removeAgentHost(url: string): void {
  const normalized = normalizeAgentHostUrl(url)
  const rest = listAgentHosts().filter((e) => e.url !== normalized)
  saveList(rest)
  if (read(SELECTED_KEY) === normalized) write(SELECTED_KEY, rest[0]?.url ?? null)
}

export function selectAgentHost(url: string): void {
  write(SELECTED_KEY, normalizeAgentHostUrl(url))
}

/**
 * El agent-host que la consola debe abrir, y su token.
 *
 * Orden: el `?url=` de la query (lo pone la app de Electron, que sabe en qué
 * puerto levantó el suyo), el último seleccionado, el primero de la lista, y
 * por último el default. Se da de alta en el momento para que un `?url=`
 * nuevo quede en la lista y se pueda volver a elegir sin tipearlo.
 */
export function resolveAgentHost(): AgentHostEntry {
  const fromQuery = new URLSearchParams(window.location.search).get('url')
  const entries = listAgentHosts()
  const chosen =
    (fromQuery && normalizeAgentHostUrl(fromQuery)) ||
    read(SELECTED_KEY) ||
    entries[0]?.url ||
    DEFAULT_AGENT_HOST_URL
  const normalized = normalizeAgentHostUrl(chosen)
  const known = entries.find((e) => e.url === normalized)
  return upsertAgentHost(normalized, known?.token ?? '')
}
