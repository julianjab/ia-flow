/**
 * A dónde va cada pedido de la web instalada (`installer/`): lo mismo que `vite preview`, sin vite. `/api/…` al
 * runner, `/<nombre>/…` a un runner de `IA_FLOW_PROXY_RUNNERS` (como en `vite.config.ts`), un archivo del build si
 * existe y, si no, `index.html` (las rutas de la SPA). Puro: `serve.ts` hace el I/O.
 */

export type Route =
  | { kind: 'proxy'; target: string }
  | { kind: 'file'; path: string; cache: 'immutable' | 'revalidate' }
  | { kind: 'spa' }

export interface ServeConfig {
  /** El runner que la web proxea en `/api` (sin barra al final). */
  runner: string
  /** `nombre → URL` de los runners extra, de `IA_FLOW_PROXY_RUNNERS`. */
  runners: Record<string, string>
}

/** `prod=https://runner.interno,dev=http://10.0.0.2:3001` → `{ prod: …, dev: … }`; lo mal escrito se ignora. */
export function parseProxyRunners(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const entry of (raw ?? '').split(',')) {
    const eq = entry.indexOf('=')
    if (eq < 0) continue
    const name = entry.slice(0, eq).trim()
    const target = entry
      .slice(eq + 1)
      .trim()
      .replace(/\/+$/, '')
    if (/^[a-z0-9-]+$/.test(name) && /^https?:\/\//.test(target)) out[name] = target
  }
  return out
}

/** El pedido (`pathname` + `search`) a su destino; `exists` dice si un archivo está en el build. */
export function route(
  pathname: string,
  search: string,
  config: ServeConfig,
  exists: (path: string) => boolean,
): Route {
  if (pathname === '/api' || pathname.startsWith('/api/'))
    return { kind: 'proxy', target: `${config.runner}${pathname}${search}` }
  const [, first = '', ...rest] = pathname.split('/')
  const remote = config.runners[first]
  if (remote && rest.length > 0)
    return { kind: 'proxy', target: `${remote}/${rest.join('/')}${search}` }
  const path = safePath(pathname)
  if (path && exists(path)) {
    // lo de `assets/` lleva hash en el nombre; el resto (index.html, sw.js, el manifest) se revalida siempre
    return { kind: 'file', path, cache: path.startsWith('assets/') ? 'immutable' : 'revalidate' }
  }
  return { kind: 'spa' }
}

/** `/assets/a.js` → `assets/a.js`; `null` para la raíz o lo que intente salir del build (`..`). */
export function safePath(pathname: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  const parts = decoded.split('/').filter(Boolean)
  if (parts.length === 0 || parts.some((p) => p === '..' || p.includes('\\'))) return null
  return parts.join('/')
}

/** Los headers que no deben pasar al runner: el `Host` lo pone `fetch` con el del destino (`changeOrigin`). */
export function forwardHeaders(headers: Headers): Headers {
  const out = new Headers(headers)
  for (const h of ['host', 'connection', 'keep-alive', 'transfer-encoding', 'accept-encoding'])
    out.delete(h)
  return out
}
