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

import { normalizeBaseUrl } from '@/features/servers/api'

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
    // `normalizeBaseUrl` y no un trim: es la MISMA función que usa `addServer`,
    // así que una entrada editada a mano como `192.168.1.9:3001` queda con su
    // esquema en vez de convertirse en una URL relativa que nunca resuelve — un
    // server "no responde" para siempre, y sin forma de arreglarlo desde la UI
    // porque la tarjeta sólo deja editar el token.
    const normalized = normalizeBaseUrl(baseUrl)
    if (!normalized) continue
    out.push({
      baseUrl: normalized,
      ...(typeof label === 'string' && label.trim() ? { label: label.trim() } : {}),
      ...(typeof token === 'string' && token ? { token } : {}),
    })
  }
  // Sin duplicados: la baseUrl es la identidad, y dos entradas con la misma
  // dejarían al usuario editando una y viendo la otra.
  const seen = new Set<string>()
  return out.filter((s) => !seen.has(s.baseUrl) && seen.add(s.baseUrl))
}

/** Lo que haya en el localStorage de esta ventana. */
function fromLocal(): SavedServer[] {
  try {
    return parseServers(JSON.parse(localStorage.getItem(KEY) ?? '[]'))
  } catch {
    return []
  }
}

/**
 * La lista, leída de donde esté.
 *
 * ── El bug que esto arregla ──────────────────────────────────────────────
 *
 * El backend NO es estable entre arranques. La app de escritorio expone el
 * puente sólo cuando pudo verificar quién sirve la página (ver `--ia-flow-
 * trusted` en apps/desktop): con un dev server ajeno ocupando el puerto, no
 * hay puente y todo va a localStorage. Al arranque siguiente, con el puerto
 * libre, SÍ hay puente — y leer sólo por ahí devolvía una lista vacía aunque
 * los servers estuvieran guardados en localStorage.
 *
 * El síntoma era exactamente "agrego servers, entro a uno, vuelvo y no están":
 * no se borraban, se leían del lado equivocado.
 *
 * Por eso se leen los DOS y se unen, en vez de elegir uno. El archivo manda
 * ante un mismo `baseUrl` —es el que sobrevive a limpiar datos del sitio— y lo
 * que sólo estaba en localStorage se sube al archivo, así la próxima lectura
 * ya no depende de qué backend haya tocado.
 */
export async function loadServers(): Promise<SavedServer[]> {
  const local = fromLocal()
  const b = bridge()
  if (!b) return local

  let stored: SavedServer[] = []
  try {
    stored = parseServers(await b.loadServers())
  } catch {
    // El main no contestó: lo de localStorage es mejor que nada.
    return local
  }

  const byUrl = new Map(local.map((s) => [s.baseUrl, s]))
  for (const s of stored) byUrl.set(s.baseUrl, s)
  const merged = [...byUrl.values()]

  // Si localStorage tenía algo que el archivo no, se sube. Una sola vez: la
  // próxima lectura ya encuentra todo del mismo lado.
  if (merged.length !== stored.length) {
    try {
      await b.saveServers(merged)
    } catch {
      /* no se pudo consolidar — la lista igual está completa en memoria */
    }
  }
  return merged
}

/**
 * Guarda en los dos lados cuando hay puente, y sólo en localStorage cuando no.
 *
 * Escribir en ambos es a propósito: es lo que hace que un arranque sin puente
 * —o al revés— siga viendo la lista. Duplicar unos KB es barato; perder los
 * servers no.
 */
export async function saveServers(servers: SavedServer[]): Promise<void> {
  try {
    localStorage.setItem(KEY, JSON.stringify(servers))
  } catch {
    /* modo privado / storage lleno */
  }
  const b = bridge()
  if (!b) return
  try {
    await b.saveServers(servers)
  } catch {
    /* el main no pudo escribir — queda lo de localStorage */
  }
}
