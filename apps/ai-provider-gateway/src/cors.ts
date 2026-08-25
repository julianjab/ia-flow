// Qué orígenes pueden hablarle a este gateway desde un browser.
//
// La consola dejó de vivir acá adentro (era una página servida por el propio
// proceso, same-origin, sin CORS): ahora es apps/web `gateway.html`, servida
// por la app de Electron o por el dev server de Vite, y apunta a la URL de
// ESTE gateway. O sea, cross-origin en todos los casos.
//
// Módulo puro, como `admission.ts` y por el mismo motivo: decide quién entra,
// y eso tiene que poder testearse sin levantar un server.

/**
 * Localhost en cualquier puerto está permitido por default.
 *
 * La consola corre en la máquina del operador y su puerto no es fijo (la app
 * de Electron sirve en uno efímero, Vite en el suyo), así que una lista de
 * puertos sería una lista que hay que mantener. El riesgo que abre es acotado:
 * el bearer vive en el localStorage del origen de la consola, y otro origen
 * —aunque también sea localhost— no puede leerlo. Sin token, todo `/v1/*`
 * responde 401.
 *
 * Lo que esto SÍ bloquea es lo que importa: una página de internet que
 * intente hablarle a tu gateway desde tu propio browser no recibe el header
 * y el browser le corta la lectura de la respuesta.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

export function isAllowedOrigin(origin: string, extra: readonly string[] = []): boolean {
  if (extra.includes(origin)) return true
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    // `null` (un file://, un sandbox) no es un origen que podamos permitir:
    // no hay nada que reflejar. La consola servida por http sí lo tiene.
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  return LOCAL_HOSTS.has(url.hostname)
}

/** Orígenes extra, separados por coma. Para una consola servida desde otra
 *  máquina (un host interno, un túnel) — nunca hace falta para el caso local. */
export function envCorsOrigins(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}
