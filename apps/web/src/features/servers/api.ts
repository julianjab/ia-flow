// Sondeo de OTROS servers ia-flow desde el navegador.
//
// A diferencia del resto de las features, acá las URLs son absolutas: el
// objetivo es justamente mirar servers distintos al que esta web proxea. Se
// puede hacer desde el browser porque el server abre CORS para todos los
// orígenes (`app.use('*', cors({ origin: '*' }))`, apps/server/src/entry/server.ts),
// y el agent-host hace lo mismo (apps/agent-host/src/cors.ts).

import type { Project } from '@ia-flow/shared'
import axios from 'axios'

/**
 * Qué API contestó en esa URL.
 *
 * No son dos productos: son los dos procesos que un operador levanta y a los
 * que le pega con el mismo browser. El server (`api: full`, o el runner) tiene
 * `/api/*`; el agent-host —el "gateway" del launcher— tiene `/v1/*` y NADA de
 * `/api/*`.
 *
 * Existe porque sin este campo los dos se veían igual de rotos: el sondeo sólo
 * conocía `/api/projects`, así que un agent-host sano devolvía 404, caía en el
 * `catch` y se dibujaba como "no responde" — indistinguible de un container
 * apagado, y sin ninguna pista de que el arreglo era otra pantalla.
 */
export type ServerKind = 'server' | 'agent-host' | 'unknown'

/** Lo que un agent-host cuenta de sí mismo. El equivalente de `projects` para el otro proceso. */
export interface AgentHostSummary {
  providerId: string
  providerName: string
  running: number
  /** `null` = sin cap declarado. */
  maxConcurrentRuns: number | null
  accepting: boolean
}

export type ProbedServer = {
  /** baseUrl sin barra final — es la identidad del server en toda la feature. */
  baseUrl: string
  /**
   * Qué contestó. Se descubre en el sondeo, no se declara al agregarlo: pedirle
   * al operador que clasifique la URL sería pedirle justo el dato que vino a
   * averiguar acá.
   */
  kind: ServerKind
  reachable: boolean
  /**
   * Contestó, pero rechazó la credencial (401/403).
   *
   * Es un estado PROPIO y no un `reachable: false`, porque el arreglo es
   * distinto: un server caído se levanta, uno que pide token se configura. Sin
   * esta distinción, olvidarse el token se veía igual que tener el server
   * apagado — y la pantalla no daba ninguna pista de cuál de las dos era.
   */
  needsToken: boolean
  /** Ida y vuelta del sondeo, para distinguir "lento" de "muerto". */
  latencyMs: number
  /** Sólo `kind: 'server'`. */
  projects: Project[]
  /** AgentHosts registrados contra él (los `remote:<name>` que puede usar). Sólo `kind: 'server'`. */
  remoteProviders: { id: string; baseUrl: string }[]
  /** Sólo `kind: 'agent-host'`. */
  agentHost: AgentHostSummary | null
}

const PROBE_TIMEOUT_MS = 1500

export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  return /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`
}

/**
 * El header de auth de ESTE server. Vacío cuando no tiene token configurado,
 * que es el caso de un server local sin `IA_FLOW_API_TOKEN`.
 *
 * `x-ia-flow-token` y no `Authorization`: los dos los acepta el server (y
 * también el agent-host, que copió el contrato a propósito — ver el comentario
 * de su guard en apps/agent-host/src/app.ts), pero un `Authorization` custom
 * dispara un preflight CORS en cada request, y el sondeo hace varias contra
 * varios orígenes.
 */
function authHeaders(token?: string): Record<string, string> {
  return token ? { 'x-ia-flow-token': token } : {}
}

/**
 * Qué hay en esa URL, sin credencial.
 *
 * El agent-host deja `GET /` FUERA de su guard justamente para esto: contesta
 * `{"service":"agent-host"}` a cualquiera. Es lo único que permite decir
 * "agent-host, pero pide token" en vez del genérico "pide token" — o sea,
 * decirle al operador en qué pantalla está el arreglo cuando todavía no puede
 * autenticarse. El server, en cambio, devuelve 404 en `/`, así que cae a
 * `unknown` sin que haya que preguntarle nada.
 */
async function sniffKind(baseUrl: string): Promise<ServerKind> {
  try {
    const { data } = await axios.get<{ service?: string }>(`${baseUrl}/`, {
      timeout: PROBE_TIMEOUT_MS,
    })
    return data?.service === 'agent-host' ? 'agent-host' : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Las dos lecturas que hacen a un agent-host presentable en una tarjeta. */
async function probeAgentHost(
  baseUrl: string,
  headers: Record<string, string>,
): Promise<AgentHostSummary | null> {
  try {
    const [provider, capacity] = await Promise.all([
      axios.get<{ id: string; name: string }>(`${baseUrl}/v1/provider`, {
        timeout: PROBE_TIMEOUT_MS,
        headers,
      }),
      axios.get<{ running: number; maxConcurrentRuns: number | null; accepting: boolean }>(
        `${baseUrl}/v1/capacity`,
        { timeout: PROBE_TIMEOUT_MS, headers },
      ),
    ])
    return {
      providerId: provider.data.id,
      providerName: provider.data.name,
      running: capacity.data.running,
      maxConcurrentRuns: capacity.data.maxConcurrentRuns,
      accepting: capacity.data.accepting,
    }
  } catch {
    return null
  }
}

/**
 * Un server ia-flow es cualquier cosa que conteste `GET /api/projects` con la
 * forma esperada; un agent-host, cualquier cosa que conteste `GET /v1/provider`.
 * Las registraciones son best-effort: un server viejo puede no tener la ruta
 * todavía, y eso no lo vuelve inalcanzable.
 *
 * **El orden importa y no es arbitrario.** `/api/projects` va primero porque es
 * el caso común y porque así un server sano sigue costando UNA request, igual
 * que antes. Sólo se prueba `/v1/*` cuando la primera devolvió una respuesta
 * HTTP que no sirve — un 404 es "hay algo escuchando, pero no tiene esta API",
 * que es exactamente la firma de un agent-host. Ante un fallo de RED no se
 * prueba nada más: no hay nadie del otro lado, y duplicar el intento sólo
 * duplicaría el `ERR_CONNECTION_REFUSED` rojo e inatrapable de la consola.
 */
export async function probeServer(baseUrl: string, token?: string): Promise<ProbedServer> {
  const startedAt = performance.now()
  const headers = authHeaders(token)
  const base = {
    baseUrl,
    kind: 'unknown' as ServerKind,
    reachable: false,
    needsToken: false,
    projects: [] as Project[],
    remoteProviders: [] as { id: string; baseUrl: string }[],
    agentHost: null as AgentHostSummary | null,
  }
  const elapsed = () => performance.now() - startedAt

  try {
    const { data } = await axios.get<{ projects?: Project[] }>(`${baseUrl}/api/projects`, {
      timeout: PROBE_TIMEOUT_MS,
      headers,
    })
    if (!Array.isArray(data?.projects)) return { ...base, latencyMs: elapsed() }

    return {
      ...base,
      kind: 'server',
      reachable: true,
      latencyMs: elapsed(),
      projects: data.projects,
      remoteProviders: await fetchRemoteProviders(baseUrl, headers),
    }
  } catch (err) {
    const status = (err as { response?: { status?: number } }).response?.status

    // Un 401/403 significa que el server está VIVO y nos rechazó — es la única
    // forma de saber que falta el token, y hay que decirlo distinto de "no
    // responde". Se sondea el tipo igual: con la credencial mal puesta, saber
    // QUÉ es lo que rechaza es la mitad del arreglo.
    if (status === 401 || status === 403) {
      return { ...base, kind: await sniffKind(baseUrl), needsToken: true, latencyMs: elapsed() }
    }

    // Contestó algo que no es la API del server. El agent-host es el caso que
    // motivó esto, pero la rama no lo asume: si `/v1/*` tampoco contesta, queda
    // "no responde" con el tipo que se pueda averiguar sin credencial.
    if (status !== undefined) {
      const agentHost = await probeAgentHost(baseUrl, headers)
      if (agentHost) {
        return { ...base, kind: 'agent-host', reachable: true, latencyMs: elapsed(), agentHost }
      }
      return { ...base, kind: await sniffKind(baseUrl), latencyMs: elapsed() }
    }

    return { ...base, latencyMs: elapsed() }
  }
}

async function fetchRemoteProviders(
  baseUrl: string,
  headers: Record<string, string>,
): Promise<{ id: string; baseUrl: string }[]> {
  try {
    const { data } = await axios.get<{ registrations?: { id: string; baseUrl: string }[] }>(
      `${baseUrl}/api/provider-registrations`,
      { timeout: PROBE_TIMEOUT_MS, headers },
    )
    return data?.registrations ?? []
  } catch {
    return []
  }
}
