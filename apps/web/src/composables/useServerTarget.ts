// A qué server le habla esta pestaña, para quien NO puede usar axios.
//
// `EventSource` (el stream del runner) y `fetch` (el stream del asistente) no
// pasan por el interceptor de axios, así que necesitan la URL absoluta y el
// token del server elegido. La elección vive en `features/servers/selection.ts`;
// esto es el borde que la expone al resto de las features sin que ninguna
// importe de `features/servers` (feature → feature está prohibido).

import { apiBase, getSelectedToken } from '@/features/servers/selection'

export interface ServerTarget {
  /** Base absoluta del server elegido; `''` cuando es el proxeado de Vite. */
  base: string
  /** El token de ia-flow del server elegido, si exige alguno. */
  token?: string
  /** `path` ya resuelto contra el server elegido. */
  url(path: string): string
}

/** Se lee en cada llamada y no se cachea: el server elegido puede cambiar. */
export function serverTarget(): ServerTarget {
  const base = apiBase()
  const token = getSelectedToken()
  return { base, token, url: (path) => `${base}${path}` }
}
