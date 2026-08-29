// Sondeo de OTROS servers ia-flow desde el navegador.
//
// A diferencia del resto de las features, acá las URLs son absolutas: el
// objetivo es justamente mirar servers distintos al que esta web proxea. Se
// puede hacer desde el browser porque el server abre CORS para todos los
// orígenes (`app.use('*', cors({ origin: '*' }))`, apps/server/src/entry/server.ts).

import type { Project } from '@ia-flow/shared'
import axios from 'axios'

export type ProbedServer = {
  /** baseUrl sin barra final — es la identidad del server en toda la feature. */
  baseUrl: string
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
  projects: Project[]
  /** AgentHosts registrados contra él (los `remote:<name>` que puede usar). */
  remoteProviders: { id: string; baseUrl: string }[]
}

const PROBE_TIMEOUT_MS = 1500

export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  return /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`
}

/**
 * Un server ia-flow es cualquier cosa que conteste `GET /api/projects` con la
 * forma esperada. Las registraciones son best-effort: un server viejo puede no
 * tener la ruta todavía, y eso no lo vuelve inalcanzable.
 */
/**
 * El header de auth de ESTE server. Vacío cuando no tiene token configurado,
 * que es el caso de un server local sin `IA_FLOW_API_TOKEN`.
 *
 * `x-ia-flow-token` y no `Authorization`: los dos los acepta el server (y ahora
 * también el agent-host), pero un `Authorization` custom dispara un preflight
 * CORS en cada request, y el sondeo hace varias contra varios orígenes.
 */
function authHeaders(token?: string): Record<string, string> {
  return token ? { 'x-ia-flow-token': token } : {}
}

export async function probeServer(baseUrl: string, token?: string): Promise<ProbedServer> {
  const startedAt = performance.now()
  const dead: ProbedServer = {
    baseUrl,
    reachable: false,
    needsToken: false,
    latencyMs: 0,
    projects: [],
    remoteProviders: [],
  }
  const headers = authHeaders(token)

  try {
    const { data } = await axios.get<{ projects?: Project[] }>(`${baseUrl}/api/projects`, {
      timeout: PROBE_TIMEOUT_MS,
      headers,
    })
    if (!Array.isArray(data?.projects)) return { ...dead, latencyMs: performance.now() - startedAt }

    return {
      baseUrl,
      reachable: true,
      needsToken: false,
      latencyMs: performance.now() - startedAt,
      projects: data.projects,
      remoteProviders: await fetchRemoteProviders(baseUrl, headers),
    }
  } catch (err) {
    // Un 401/403 significa que el server está VIVO y nos rechazó — es la única
    // forma de saber que falta el token, y hay que decirlo distinto de "no
    // responde".
    const status = (err as { response?: { status?: number } }).response?.status
    const needsToken = status === 401 || status === 403
    return { ...dead, needsToken, latencyMs: performance.now() - startedAt }
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
