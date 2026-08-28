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
  saveServers(payload: unknown): Promise<void>
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

/**
 * La lista, más CUÁNDO se escribió.
 *
 * La revisión es lo que hace que dos backends no se peleen. Sin ella hubo que
 * elegir entre dos comportamientos malos: leer sólo uno (y perder lo del otro)
 * o unirlos (y hacer imposible borrar — un server eliminado en un lado
 * resucitaba desde el otro). Con una revisión no hay que elegir: la lista se
 * escribe SIEMPRE entera, así que la escritura más nueva es la verdad, tanto si
 * agregó como si borró.
 */
interface Stored {
  rev: number
  servers: SavedServer[]
}

/** Formato viejo: un array pelado. Cuenta como la revisión más vieja posible. */
function parseStored(raw: unknown): Stored {
  if (Array.isArray(raw)) return { rev: 0, servers: parseServers(raw) }
  if (raw && typeof raw === 'object') {
    const { rev, servers } = raw as Record<string, unknown>
    return {
      rev: typeof rev === 'number' && Number.isFinite(rev) ? rev : 0,
      servers: parseServers(servers),
    }
  }
  return { rev: 0, servers: [] }
}

function fromLocal(): Stored {
  try {
    return parseStored(JSON.parse(localStorage.getItem(KEY) ?? 'null'))
  } catch {
    return { rev: 0, servers: [] }
  }
}

/**
 * Monótona dentro de la sesión y ordenada en el tiempo entre sesiones.
 *
 * `Date.now()` sin más alcanzaría casi siempre, pero dos guardados en el mismo
 * milisegundo empatarían y un reloj que retrocede invertiría el orden. El
 * `max` con la última emitida lo vuelve inmune a las dos cosas.
 */
let lastRev = 0
function nextRev(): number {
  lastRev = Math.max(lastRev + 1, Date.now())
  return lastRev
}

/**
 * Une dos listas por `baseUrl`, sin duplicar.
 *
 * Sólo se usa para migrar las dos copias pre-revisión (ver `loadServers`). `a`
 * manda en un conflicto, pero los campos que le falten se completan con los de
 * `b`: si un lado tiene el token de un server y el otro no, quedarse con el
 * vacío obligaría a tipearlo de nuevo sin ninguna ganancia.
 */
function unionServers(a: SavedServer[], b: SavedServer[]): SavedServer[] {
  const byUrl = new Map(a.map((s) => [s.baseUrl, s]))
  for (const s of b) {
    const existing = byUrl.get(s.baseUrl)
    if (!existing) {
      byUrl.set(s.baseUrl, s)
      continue
    }
    byUrl.set(s.baseUrl, {
      ...existing,
      ...(existing.label ? {} : s.label ? { label: s.label } : {}),
      ...(existing.token ? {} : s.token ? { token: s.token } : {}),
    })
  }
  return [...byUrl.values()]
}

/** Escribe la misma revisión en los dos lados. Ninguna falla es fatal. */
async function writeBoth(b: DesktopBridge, payload: Stored): Promise<void> {
  try {
    localStorage.setItem(KEY, JSON.stringify(payload))
  } catch {
    /* modo privado / storage lleno */
  }
  try {
    await b.saveServers(payload)
  } catch {
    /* el main no pudo escribir — queda lo de localStorage */
  }
}

/**
 * La lista, de donde esté y en su versión más nueva.
 *
 * ── El bug que esto arregla ──────────────────────────────────────────────
 *
 * El backend NO es estable entre arranques. La app de escritorio expone su
 * puente sólo cuando pudo verificar quién sirve la página (ver
 * `--ia-flow-trusted` en apps/desktop): con un dev server ajeno ocupando el
 * puerto no hay puente y todo va a localStorage; al arranque siguiente, con el
 * puerto libre, sí lo hay. Leer de un solo lado devolvía una lista vacía aunque
 * los servers estuvieran guardados en el otro.
 *
 * El síntoma era "agrego servers, entro a uno, vuelvo y no están": no se
 * borraban, se leían del lado equivocado.
 */
export async function loadServers(): Promise<SavedServer[]> {
  const local = fromLocal()
  lastRev = Math.max(lastRev, local.rev)

  const b = bridge()
  if (!b) return local.servers

  let stored: Stored
  try {
    stored = parseStored(await b.loadServers())
  } catch {
    // El main no contestó: lo de localStorage es mejor que nada.
    return local.servers
  }
  lastRev = Math.max(lastRev, stored.rev)

  // Empate a 0: NINGUNO de los dos lados tiene revisión, o sea que los dos
  // vienen de antes de que existiera este mecanismo. Es el único caso en el que
  // unir es correcto — y es obligatorio, porque acá "gana el archivo" perdía
  // datos de verdad: un server guardado sólo en localStorage (el arranque sin
  // puente, que es justamente el bug que motivó todo esto) quedaba tapado por
  // un archivo igual de viejo, y como la convergencia sólo corre cuando las
  // revisiones difieren, se repetía en CADA carga. Desaparecía para siempre.
  //
  // Unir no resucita nada borrado porque en la era pre-revisión ningún lado
  // registró un borrado: sólo hay listas incompletas. Se sella con una revisión
  // nueva, así que a partir de acá vuelve a mandar la última escritura y borrar
  // se propaga como debe.
  if (local.rev === 0 && stored.rev === 0) {
    const merged = unionServers(stored.servers, local.servers)
    await writeBoth(b, { rev: nextRev(), servers: merged })
    return merged
  }

  // Empate con revisión: las dos copias vienen de la MISMA escritura (saveServers
  // manda la misma rev a los dos lados), así que ya están convergidas.
  //
  // Cuando difieren gana la más nueva, sin mirar el contenido: la lista se
  // escribe siempre entera, así que la escritura más reciente es la verdad tanto
  // si agregó como si borró.
  const winner = local.rev > stored.rev ? local : stored
  const loser = winner === local ? stored : local

  // Converger, para que la próxima lectura no dependa de qué backend responda.
  if (winner.rev !== loser.rev) {
    if (winner === local) {
      try {
        await b.saveServers(winner)
      } catch {
        /* no se pudo consolidar — la lista igual está completa en memoria */
      }
    } else {
      try {
        localStorage.setItem(KEY, JSON.stringify(winner))
      } catch {
        /* ídem */
      }
    }
  }
  return winner.servers
}

/**
 * Guarda en los dos lados cuando hay puente, y sólo en localStorage cuando no.
 *
 * Escribir en ambos es a propósito: es lo que hace que un arranque sin puente
 * —o al revés— siga viendo la lista. Y va la lista ENTERA con su revisión, no
 * un delta: es lo que permite que borrar se propague igual que agregar.
 */
export async function saveServers(servers: SavedServer[]): Promise<void> {
  const payload: Stored = { rev: nextRev(), servers }
  const b = bridge()
  if (!b) {
    try {
      localStorage.setItem(KEY, JSON.stringify(payload))
    } catch {
      /* modo privado / storage lleno */
    }
    return
  }
  await writeBoth(b, payload)
}
