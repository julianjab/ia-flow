// A qué server le está mirando los datos esta pestaña.
//
// Es la única pieza que traduce "el server que elegiste" a config real de red.
// El resto de la app sigue pidiendo rutas relativas (`/api/...`) sin enterarse:
// acá se setea `axios.defaults.baseURL`, así que un cambio de server no toca
// ni una línea de las features.
//
// Se puede apuntar a otro origen porque el server abre CORS para todos
// (`app.use('*', cors({ origin: '*' }))`, apps/server/src/entry/server.ts).

import { normalizeBaseUrl } from '@/features/servers/api'
import axios from 'axios'

const SELECTED_KEY = 'ia-flow:servers:selected'

/**
 * El server que la web proxea por su cuenta (VITE_API_TARGET al arrancar).
 * Es el default: sin elección explícita, todo sigue funcionando como antes,
 * contra el proxy de Vite y con rutas relativas.
 */
export const PROXIED_BASE_URL = (import.meta.env.VITE_API_BASE as string | undefined) ?? ''

let selected: string | null = null

export function getSelectedServer(): string | null {
  return selected
}

/**
 * Base absoluta para quien NO puede usar rutas relativas (WebSocket, `<img>`,
 * EventSource). Devuelve '' cuando estamos en el server proxeado, que es lo
 * que hace que las rutas relativas sigan siendo lo normal.
 */
export function apiBase(): string {
  return selected ?? PROXIED_BASE_URL
}

/** Host:puerto para el WebSocket — el `location.host` deja de servir al cambiar. */
export function wsOrigin(): string {
  const base = apiBase()
  return base ? new URL(base).host : window.location.host
}

/**
 * El server que se está mirando, absoluto y normalizado.
 *
 * Es una función, NO una const de módulo: los módulos se evalúan al
 * importarse, y eso pasa ANTES de que main.ts restaure la elección guardada —
 * una const habría quedado congelada en el server proxeado, marcando el server
 * equivocado como "estás acá".
 */
export function currentBaseUrl(): string {
  return normalizeBaseUrl(selected ?? PROXIED_BASE_URL ?? window.location.origin)
}

/** El token del server elegido. No es un default de axios — ver abajo. */
let selectedToken: string | undefined

/**
 * ¿Esta request va al server elegido?
 *
 * Compara ORIGEN, no la URL entera: `baseURL` + `url` se combinan distinto
 * según quién llame (rutas relativas desde las features, absolutas desde el
 * sondeo), y lo único que decide si la credencial corresponde es a qué host
 * está saliendo.
 */
function targetsSelected(baseURL: string | undefined, url: string | undefined): boolean {
  if (!selected) return false
  const raw = url ?? ''
  const abs = /^https?:\/\//i.test(raw) ? raw : `${baseURL ?? ''}${raw}`
  try {
    return new URL(abs).origin === new URL(selected).origin
  } catch {
    // Sin URL absoluta no hay forma de saber a dónde va: no se manda el token.
    return false
  }
}

/**
 * El header de auth, aplicado por INTERCEPTOR y no como default global.
 *
 * `axios.defaults.headers.common` parece lo natural —cada feature importa
 * `axios` directo, así que un default cubre las ~24 rutas sin tocar 20
 * archivos— pero se mergea en TODA request, y eso filtraba la credencial por
 * dos caminos:
 *
 *  - el sondeo de la pantalla de servers le pega a CADA URL declarada, que son
 *    hosts arbitrarios que el usuario tipeó. El token del server elegido salía
 *    hacia todos ellos.
 *  - `axios.create()` hereda los defaults, así que el cliente del gateway
 *    mandaba su `Bearer` correcto Y el `x-ia-flow-token` del server de ia-flow.
 *    El guard del gateway prefiere `x-ia-flow-token`, así que además de filtrar
 *    el token, respondía 401 con la credencial correcta.
 *
 * El interceptor lo aplica sólo cuando la request va al origen del server
 * elegido, y no pisa un header ya puesto explícitamente por quien llama.
 */
axios.interceptors.request.use((config) => {
  if (!selectedToken) return config
  if (!targetsSelected(config.baseURL, config.url)) return config
  config.headers.set?.('x-ia-flow-token', selectedToken, false)
  return config
})

function applyToken(token: string | undefined): void {
  selectedToken = token
}

/**
 * Aplica una elección a esta pestaña. `null` = volver al server proxeado.
 *
 * El token viaja junto a la URL y no aparte a propósito: son una unidad, y
 * separarlos abre la puerta a aplicar uno sin el otro.
 */
export function selectServer(baseUrl: string | null, token?: string): void {
  selected = baseUrl
  axios.defaults.baseURL = baseUrl ?? undefined
  applyToken(token)
  try {
    if (baseUrl) localStorage.setItem(SELECTED_KEY, baseUrl)
    else localStorage.removeItem(SELECTED_KEY)
  } catch {
    /* modo privado — la elección vale para esta sesión y nada más */
  }
}

/**
 * Restaura la elección guardada. Se llama una vez, antes de montar la app.
 *
 * Sólo restaura la URL: el token lo aplica el store cuando termina de cargar
 * la lista, que es asíncrona (puede venir del disco por IPC). Mientras tanto
 * las requests salen sin token — si el server lo exige, contestan 401 y la
 * pantalla de servers lo muestra como "pide token", que es exactamente lo que
 * hay que ver en ese estado.
 */
export function restoreSelectedServer(): string | null {
  try {
    selectServer(localStorage.getItem(SELECTED_KEY))
  } catch {
    selectServer(null)
  }
  return selected
}

/** Re-aplica el token del server ya elegido, una vez que la lista cargó. */
export function applySelectedToken(token: string | undefined): void {
  applyToken(token)
}
