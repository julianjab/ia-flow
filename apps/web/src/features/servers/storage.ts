// Dónde vive la lista de servers, y su token.
//
// ── Por qué existe este archivo ──────────────────────────────────────────
//
// La lista NO se descubre: se declara. Antes esta feature barría 17 puertos de
// localhost la primera vez y "aprendía" lo que respondiera. Eso tenía tres
// problemas: sólo encontraba servers locales (un server en otra máquina había
// que agregarlo a mano igual), cada sondeo fallido dejaba un
// ERR_CONNECTION_REFUSED rojo e inatrapable en la consola, y adivinaba —
// listaba como "servers" puertos que resultaban ser cualquier otra cosa.
//
// Ahora es config: agregás un server, queda guardado, y la app sondea
// exactamente esos.
//
// ── Dónde se guarda ──────────────────────────────────────────────────────
//
// Depende de quién corre la web, y por eso hay una abstracción y no un
// `localStorage` directo:
//
//   app de escritorio → un archivo en el config dir, vía IPC al main process.
//                       Sobrevive a limpiar el navegador y es inspeccionable.
//   browser (dev)     → localStorage, que es lo único que hay.
//
// El puente lo expone el preload como `window.iaFlowDesktop`. Si no está,
// estamos en un browser y se cae a localStorage sin que nadie tenga que
// preguntarse dónde corre.

/** Un server declarado por el usuario. */
export interface SavedServer {
  /** Sin barra final — es la identidad del server en toda la feature. */
  baseUrl: string
  /** Nombre para humanos. Vacío = se muestra la URL. */
  label?: string
  /**
   * El token que ESTE server exige (`IA_FLOW_API_TOKEN`), si exige alguno.
   *
   * Vive junto al server y no como un valor global porque es por server: lo
   * normal es tener uno local sin token y uno remoto con token. Antes salía de
   * `VITE_IA_FLOW_API_TOKEN`, horneado en tiempo de build — o sea uno solo
   * para todos, y congelado adentro del .dmg publicado.
   */
  token?: string
}

/** Lo que el preload de la app de escritorio expone, si estamos ahí. */
interface DesktopBridge {
  loadServers(): Promise<unknown>
  saveServers(servers: SavedServer[]): Promise<void>
}

function bridge(): DesktopBridge | null {
  const b = (globalThis as { iaFlowDesktop?: DesktopBridge }).iaFlowDesktop
  return b && typeof b.loadServers === 'function' ? b : null
}

const KEY = 'ia-flow:servers:list'

/**
 * Valida lo que sale del disco o del localStorage.
 *
 * Es entrada no confiable en el sentido literal: un archivo que alguien editó
 * a mano, o un localStorage de una versión anterior del schema. Se descartan
 * las entradas rotas en vez de tirar — perder un server de la lista es
 * recuperable tipeándolo; una excepción acá deja la pantalla en blanco.
 */
export function parseServers(raw: unknown): SavedServer[] {
  if (!Array.isArray(raw)) return []
  const out: SavedServer[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const { baseUrl, label, token } = entry as Record<string, unknown>
    if (typeof baseUrl !== 'string' || !baseUrl.trim()) continue
    out.push({
      baseUrl: baseUrl.trim().replace(/\/+$/, ''),
      ...(typeof label === 'string' && label.trim() ? { label: label.trim() } : {}),
      ...(typeof token === 'string' && token ? { token } : {}),
    })
  }
  // Sin duplicados: la baseUrl es la identidad, y dos entradas con la misma
  // dejarían al usuario editando una y viendo la otra.
  const seen = new Set<string>()
  return out.filter((s) => !seen.has(s.baseUrl) && seen.add(s.baseUrl))
}

export async function loadServers(): Promise<SavedServer[]> {
  const b = bridge()
  if (b) {
    try {
      return parseServers(await b.loadServers())
    } catch {
      // El main process no contestó. Mejor una lista vacía que una pantalla
      // rota: el usuario puede volver a agregar sus servers.
      return []
    }
  }
  try {
    return parseServers(JSON.parse(localStorage.getItem(KEY) ?? '[]'))
  } catch {
    return []
  }
}

export async function saveServers(servers: SavedServer[]): Promise<void> {
  const b = bridge()
  if (b) {
    try {
      await b.saveServers(servers)
    } catch {
      /* el main no pudo escribir — la lista sigue viva en memoria */
    }
    return
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(servers))
  } catch {
    /* modo privado / storage lleno — ídem */
  }
}
