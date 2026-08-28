import { timingSafeEqual } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'

/**
 * Guard de la API completa (`api: full`) por token compartido.
 *
 * Existe porque `mountApiRoutes` publica 24 routers sin auth propia, y dos de
 * ellos bastan para comprometer el deploy: `PUT /api/env-vars` persiste env
 * vars en runtime (un `ANTHROPIC_BASE_URL` ajeno es exfiltración) y
 * `POST /api/tasks` despacha agentes con la identidad de GitHub del runner.
 * Mientras el único despliegue fue un contenedor local con el puerto en
 * 127.0.0.1 eso alcanzaba; en Kubernetes el Service lo hace alcanzable desde
 * cualquier pod del cluster.
 *
 * Misma forma que el guard de `remote-logs.ts`, a propósito:
 *
 *   - **Lectura perezosa.** `envRepo.loadIntoProcess()` corre DESPUÉS de que
 *     los módulos se importan, así que leer el token al importar lo dejaría
 *     `undefined` para siempre.
 *   - **`timingSafeEqual`.** Comparar con `===` filtra el largo del prefijo
 *     correcto por diferencia de tiempo.
 *   - **Fail-closed.** Sin token configurado NO se abre: se rechaza todo. Un
 *     guard que se desactiva solo cuando falta su secreto es peor que no
 *     tenerlo, porque promete algo que no cumple.
 */
function apiToken(): string | undefined {
  const raw = process.env.IA_FLOW_API_TOKEN?.trim()
  return raw ? raw : undefined
}

function secretEquals(provided: string | undefined, secret: string): boolean {
  if (!provided) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(secret)
  // timingSafeEqual tira si los largos difieren, así que hay que cortar antes
  // — y el largo no es lo que este guard protege.
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Rutas que NO pasan por este guard porque tienen la suya:
 *
 *   - `/api/webhooks/*` — HMAC de GitHub contra `IA_FLOW_WEBHOOK_SECRET`. Es
 *     la única ruta publicada a internet; meterle un segundo secreto la
 *     rompería, porque GitHub sólo manda su firma.
 *   - `/api/remote-logs` y `/api/remote-executions` — ya validan
 *     `IA_FLOW_REMOTE_LOG_TOKEN`, que es un secreto distinto y compartido con
 *     otro daemon.
 */
const EXEMPT = ['/api/webhooks', '/api/remote-logs', '/api/remote-executions']

export function createApiAuthMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const path = c.req.path
    if (EXEMPT.some((p) => path === p || path.startsWith(`${p}/`))) return next()

    const secret = apiToken()
    if (!secret) {
      return c.json(
        { error: 'API deshabilitada: falta IA_FLOW_API_TOKEN. Con `api: full` es obligatorio.' },
        503,
      )
    }

    const provided =
      c.req.header('x-ia-flow-token') ??
      c.req.header('authorization')?.replace(/^Bearer\s+/i, '')

    if (!secretEquals(provided, secret)) return c.json({ error: 'invalid token' }, 401)
    return next()
  }
}
