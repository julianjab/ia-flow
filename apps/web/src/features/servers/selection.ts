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
 * El token del server elegido, junto a la elección.
 *
 * Es una copia de lo que ya está en la lista de servers, y existe por un
 * motivo de TIMING: `enter()` navega con `window.location.assign`, o sea una
 * recarga completa, y del otro lado `restoreSelectedServer()` corre ANTES de
 * montar la app. La lista, en cambio, se carga async (puede venir del disco por
 * IPC) y sólo la monta la pantalla de servers. Sin esta copia, entrar a un
 * server con token dejaba toda la app en 401 hasta volver al picker — que es
 * justamente la pantalla a la que ya no ibas a volver.
 */
const SELECTED_TOKEN_KEY = 'ia-flow:servers:selected-token'

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
  // `||` y no `??`: PROXIED_BASE_URL es `''` cuando no hay VITE_API_BASE, que
  // es falsy pero NO nullish — con `??` el fallback a location.origin era
  // código muerto, y `removeServer` dejaba de proteger al server actual.
  return normalizeBaseUrl(selected || PROXIED_BASE_URL || window.location.origin)
}

/** El token del server elegido. No es un default de axios — ver abajo. */
let selectedToken: string | undefined

/**
 * ¿Esta request va al server que estamos mirando?
 *
 * Compara ORIGEN, no la URL entera: `baseURL` + `url` se combinan distinto
 * según quién llame (rutas relativas desde las features, absolutas desde el
 * sondeo), y lo único que decide si la credencial corresponde es a qué host
 * está saliendo.
 *
 * El caso del server PROXEADO es el que hay que tener en la cabeza. Cuando
 * elegís ese, `selected` queda en `null` —a propósito, para que las rutas
 * relativas sigan pasando por el proxy de Vite— y las requests salen sin
 * `baseURL`, hacia el origen de la página. Compararlas contra `selected` daría
 * false y el token no se mandaría nunca: entrar a `localhost:3001` (el default
 * horneado, o sea el caso MÁS común) dejaba toda la app en 401.
 */
function targetsSelected(baseURL: string | undefined, url: string | undefined): boolean {
  const raw = url ?? ''
  const absolute = /^https?:\/\//i.test(raw)

  // Relativa y sin baseURL: va al origen de la página, que es el proxy. Sólo
  // corresponde el token si lo que estamos mirando ES el server proxeado.
  if (!absolute && !baseURL) return !selected

  const target = selected ?? PROXIED_BASE_URL
  if (!target) return false
  const abs = absolute ? raw : `${baseURL ?? ''}${raw}`
  try {
    return new URL(abs).origin === new URL(target).origin
  } catch {
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
 *  - `axios.create()` hereda los defaults, así que el cliente del agent-host
 *    mandaba su `Bearer` correcto Y el `x-ia-flow-token` del server de ia-flow.
 *    El guard del agent-host prefiere `x-ia-flow-token`, así que además de filtrar
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
    if (token) localStorage.setItem(SELECTED_TOKEN_KEY, token)
    else localStorage.removeItem(SELECTED_TOKEN_KEY)
  } catch {
    /* modo privado — la elección vale para esta sesión y nada más */
  }
}

/**
 * Restaura la elección guardada. Se llama una vez, antes de montar la app.
 *
 * Restaura URL **y** token, sincrónicamente, desde el localStorage. Tiene que
 * ser sincrónico: corre antes de montar la app, y las primeras requests de cada
 * store salen enseguida.
 */
export function restoreSelectedServer(): string | null {
  try {
    selectServer(
      localStorage.getItem(SELECTED_KEY),
      localStorage.getItem(SELECTED_TOKEN_KEY) ?? undefined,
    )
  } catch {
    selectServer(null)
  }
  return selected
}

/** Re-aplica el token del server ya elegido, una vez que la lista cargó. */
export function applySelectedToken(token: string | undefined): void {
  applyToken(token)
}
