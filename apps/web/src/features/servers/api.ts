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
  /** Ida y vuelta del sondeo, para distinguir "lento" de "muerto". */
  latencyMs: number
  projects: Project[]
  /** Gateways registrados contra él (los `remote:<name>` que puede usar). */
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
export async function probeServer(baseUrl: string): Promise<ProbedServer> {
  const startedAt = performance.now()
  const dead: ProbedServer = {
    baseUrl,
    reachable: false,
    latencyMs: 0,
    projects: [],
    remoteProviders: [],
  }

  try {
    const { data } = await axios.get<{ projects?: Project[] }>(`${baseUrl}/api/projects`, {
      timeout: PROBE_TIMEOUT_MS,
    })
    if (!Array.isArray(data?.projects)) return { ...dead, latencyMs: performance.now() - startedAt }

    return {
      baseUrl,
      reachable: true,
      latencyMs: performance.now() - startedAt,
      projects: data.projects,
      remoteProviders: await fetchRemoteProviders(baseUrl),
    }
  } catch {
    return { ...dead, latencyMs: performance.now() - startedAt }
  }
}

async function fetchRemoteProviders(baseUrl: string): Promise<{ id: string; baseUrl: string }[]> {
  try {
    const { data } = await axios.get<{ registrations?: { id: string; baseUrl: string }[] }>(
      `${baseUrl}/api/provider-registrations`,
      { timeout: PROBE_TIMEOUT_MS },
    )
    return data?.registrations ?? []
  } catch {
    return []
  }
}
