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

/** Aplica una elección a esta pestaña. `null` = volver al server proxeado. */
export function selectServer(baseUrl: string | null): void {
  selected = baseUrl
  axios.defaults.baseURL = baseUrl ?? undefined
  try {
    if (baseUrl) localStorage.setItem(SELECTED_KEY, baseUrl)
    else localStorage.removeItem(SELECTED_KEY)
  } catch {
    /* modo privado — la elección vale para esta sesión y nada más */
  }
}

/** Restaura la elección guardada. Se llama una vez, antes de montar la app. */
export function restoreSelectedServer(): string | null {
  try {
    selectServer(localStorage.getItem(SELECTED_KEY))
  } catch {
    selectServer(null)
  }
  return selected
}
