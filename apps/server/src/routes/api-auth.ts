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
 * QUE PROTEGE Y QUE NO. Este token acota a OTROS workloads: en Kubernetes el
 * Service deja la API alcanzable desde cualquier pod del cluster, y eso es lo
 * que cierra.
 *
 * Lo que NO acota es al agente de este mismo proceso. `bash_run` spawnea hijos
 * del runner, asi que heredan su env: un agente puede leer `IA_FLOW_API_TOKEN`
 * igual que lee `CLAUDE_CODE_OAUTH_TOKEN`, `SLACK_BOT_TOKEN` o el PEM montado.
 * No hay separacion posible sin sacar la ejecucion del proceso.
 *
 * Eso no es una regresion de este guard: el agente YA tiene la identidad de
 * GitHub, la de Anthropic y la de Slack por diseño — sumarle este token no le
 * da nada que no tuviera. Pero conviene no leer "la API esta protegida" como
 * "protegida del agente"; la frontera de ese lado es el deny-list de
 * `bash_run` y la imagen, no este middleware.
 *
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
 *   - `/api/webhooks/github` — HMAC de GitHub contra `IA_FLOW_WEBHOOK_SECRET`.
 *     Es una de las rutas publicadas a internet; meterle un segundo secreto la
 *     rompería, porque GitHub sólo manda su firma.
 *   - `/api/webhooks/slack` — lo mismo, con el HMAC `v0=` de Slack contra
 *     `SLACK_SIGNING_SECRET` (`verifySlackSignature`, en `@ia-flow/slack`).
 *     Slack tampoco puede mandar un `x-ia-flow-token`, así que sin esta
 *     entrada la Events API muere en el guard —503 sin token configurado, 401
 *     con él— ANTES de que su propia firma se verifique, y el síntoma es
 *     "Slack no dispara reglas" sin una sola línea en los logs.
 *   - `/api/remote-logs` y `/api/remote-executions` — ya validan
 *     `IA_FLOW_REMOTE_LOG_TOKEN`, que es un secreto distinto y compartido con
 *     otro daemon.
 *
 * La lista es de rutas EXACTAS, no de prefijos, y eso es deliberado: eximir
 * `/api/webhooks` entero dejaba `GET /api/webhooks/status` sin auth, y esa
 * ruta —unauthenticated por diseño, pensada para una API local— devuelve la
 * lista de proyectos, los webhook targets y si hay secret configurado. Un
 * `pathType: Exact` en el ingress cierra eso desde internet, pero no desde
 * dentro del cluster; esto sí.
 */
const EXEMPT = [
  '/api/webhooks/github',
  '/api/webhooks/slack',
  '/api/remote-logs',
  '/api/remote-executions',
]

export interface ApiAuthOptions {
  /**
   * Qué hacer cuando NO hay `IA_FLOW_API_TOKEN` configurado.
   *
   * `false` (default) es fail-closed: se rechaza todo con 503. Es lo correcto
   * para `api: full` en Kubernetes, donde el Service deja la API alcanzable
   * desde cualquier pod y un guard que se apaga solo cuando falta su secreto
   * promete algo que no cumple.
   *
   * `true` deja pasar. Es para el server de desarrollo, donde el punto de
   * partida es que NO hay auth ninguna: montarlo fail-closed rompería cada
   * setup local que no tiene el token, y "protege si lo configurás" es
   * estrictamente mejor que hoy sin romper a nadie.
   *
   * La distinción es sobre el DESPLIEGUE, no sobre la ruta: la misma API con
   * el mismo token, expuesta de dos maneras distintas.
   */
  openWithoutToken?: boolean
}

export function createApiAuthMiddleware(opts: ApiAuthOptions = {}): MiddlewareHandler {
  return async (c, next) => {
    const path = c.req.path
    if (EXEMPT.includes(path)) return next()

    const secret = apiToken()
    if (!secret) {
      if (opts.openWithoutToken) return next()
      return c.json(
        { error: 'API deshabilitada: falta IA_FLOW_API_TOKEN. Con `api: full` es obligatorio.' },
        503,
      )
    }

    const provided =
      // `||` y no `??`: un `x-ia-flow-token` VACÍO no es nullish, así que con
      // `??` descartaba el fallback a `Authorization` y devolvía 401 aunque el
      // Bearer fuera correcto. Un header vacío es "no mandó token", no "mandó
      // el token vacío".
      c.req.header('x-ia-flow-token') || c.req.header('authorization')?.replace(/^Bearer\s+/i, '')

    if (!secretEquals(provided, secret)) return c.json({ error: 'invalid token' }, 401)
    return next()
  }
}
