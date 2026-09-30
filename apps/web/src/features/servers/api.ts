// Sondeo de OTROS runners desde el navegador.
//
// A diferencia del resto de las features, acá las URLs son absolutas: el
// objetivo es justamente mirar servers distintos al que esta web proxea. Se
// puede hacer desde el browser porque el runner abre CORS para todos los
// orígenes.

import { type InboxProject, RunnerInfoSchema } from '@ia-flow/shared'
import axios from 'axios'

/**
 * Qué contestó en esa URL.
 *
 * `runner` es un runner-v2 (`GET /api/runner` con `service: 'ia-flow-runner'`):
 * lo único que esta web sabe operar. Todo lo demás —el `apps/server` v1, un
 * agent-host, cualquier otra cosa— es `unknown`.
 */
export type ServerKind = 'runner' | 'unknown'

export type ProbedServer = {
  /** baseUrl sin barra final — es la identidad del server en toda la feature. */
  baseUrl: string
  kind: ServerKind
  reachable: boolean
  /**
   * Contestó, pero rechazó la credencial (401/403).
   *
   * Es un estado PROPIO y no un `reachable: false`, porque el arreglo es
   * distinto: un server caído se levanta, uno que pide token se configura.
   */
  needsToken: boolean
  /** Ida y vuelta del sondeo, para distinguir "lento" de "muerto". */
  latencyMs: number
  /** Sólo `kind: 'runner'`. */
  projects: InboxProject[]
  version?: string
  /** El runner ofrece login con GitHub por device flow. */
  deviceFlow: boolean
  /** El runner tiene el asistente montado. */
  assistant: boolean
}

const PROBE_TIMEOUT_MS = 1500

export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  return /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`
}

/**
 * El header de auth de ESTE server. Vacío cuando no tiene token configurado.
 *
 * `x-ia-flow-token` y no `Authorization`: un `Authorization` custom dispara un
 * preflight CORS en cada request, y el sondeo hace varias contra varios orígenes.
 */
function authHeaders(token?: string): Record<string, string> {
  return token ? { 'x-ia-flow-token': token } : {}
}

/**
 * Un runner es cualquier cosa que conteste `GET /api/runner` con la forma
 * esperada. Una sola request por server.
 */
export async function probeServer(baseUrl: string, token?: string): Promise<ProbedServer> {
  const startedAt = performance.now()
  const base: ProbedServer = {
    baseUrl,
    kind: 'unknown',
    reachable: false,
    needsToken: false,
    latencyMs: 0,
    projects: [],
    deviceFlow: false,
    assistant: false,
  }
  const elapsed = () => performance.now() - startedAt

  try {
    const { data } = await axios.get<unknown>(`${baseUrl}/api/runner`, {
      timeout: PROBE_TIMEOUT_MS,
      headers: authHeaders(token),
    })
    const info = RunnerInfoSchema.safeParse(data)
    // Contestó otra cosa (un v1, un HTML del fallback de la SPA): hay algo
    // escuchando, pero no es un runner.
    if (!info.success) return { ...base, latencyMs: elapsed() }
    return {
      ...base,
      kind: 'runner',
      reachable: true,
      latencyMs: elapsed(),
      projects: info.data.projects,
      version: info.data.version,
      deviceFlow: info.data.github_login.device_flow,
      assistant: info.data.assistant,
    }
  } catch (err) {
    const status = (err as { response?: { status?: number } }).response?.status
    // Un 401/403 significa que el server está VIVO y nos rechazó: hay que
    // decirlo distinto de "no responde".
    if (status === 401 || status === 403) {
      return { ...base, needsToken: true, latencyMs: elapsed() }
    }
    return { ...base, latencyMs: elapsed() }
  }
}
