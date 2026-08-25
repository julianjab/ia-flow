// A qué gateway le habla esta consola, y con qué token.
//
// Es el equivalente de `features/servers/selection.ts` para el otro proceso:
// la consola no vive adentro del gateway (antes sí — era una página que él
// mismo servía), así que la URL es un dato, no el origen de la página.
//
// De dónde sale, en orden: el `?url=` de la query (lo pone la app de Electron,
// que sabe en qué puerto levantó el gateway), lo último guardado, y por
// último el default de siempre. Se guarda apenas se resuelve para que un
// reload sin query siga apuntando al mismo lado.
//
// El token NO viaja en la query: lo escribe el preload de Electron en el
// localStorage de ESTE origen, o lo tipea el operador. Es la misma clave que
// usaba la pantalla vieja, así que una instalación existente no lo pierde.

const URL_KEY = 'ia-flow:gateway:url'
const TOKEN_KEY = 'ia-flow:gateway:token'

export const DEFAULT_GATEWAY_URL = 'http://localhost:3002'

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

export function resolveGatewayUrl(): string {
  const fromQuery = new URLSearchParams(window.location.search).get('url')
  const chosen = fromQuery || read(URL_KEY) || DEFAULT_GATEWAY_URL
  const normalized = normalizeGatewayUrl(chosen)
  write(URL_KEY, normalized)
  return normalized
}

export function setGatewayUrl(url: string): string {
  const normalized = normalizeGatewayUrl(url)
  write(URL_KEY, normalized)
  return normalized
}

export function getToken(): string {
  return read(TOKEN_KEY) ?? ''
}

export function setToken(token: string): void {
  write(TOKEN_KEY, token.trim() || null)
}
