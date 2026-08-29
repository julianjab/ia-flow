import type { RemoteProviderHealth } from '@ia-flow/shared'
import axios from 'axios'

// Mirrors toPublicRegistration() in apps/server/src/routes/provider-registrations-logic.ts
// — never carries the real token, just whether one is set.
export interface ProviderRegistration {
  id: string
  name: string
  baseUrl: string
  remoteKind: 'sync' | 'async'
  remoteName: string
  remoteDescription: string
  createdAt: string
  hasToken: boolean
  /** Salud del agent-host. Sólo con `ok` el provider está registrado en el
   *  server y es elegible por un agente — ver
   *  apps/server/src/adapters/remote-provider/RemoteProviderHealthMonitor.ts. */
  health: RemoteProviderHealth
}

/**
 * Un server anterior al monitor de salud no manda `health`, y desde que la web
 * elige contra qué server mirar eso dejó de ser hipotético: el mismo build
 * puede apuntar a un runner en un container que quedó atrás. Sin esto el
 * render explotaba (`reading 'status' of undefined`) y la sección quedaba
 * colgada en "Cargando…" para siempre.
 */
const UNKNOWN_HEALTH: RemoteProviderHealth = { status: 'unknown', consecutiveFailures: 0 }

export interface CreateProviderRegistrationInput {
  name: string
  baseUrl: string
  token: string
}

export async function listProviderRegistrations(): Promise<ProviderRegistration[]> {
  const { data } = await axios.get<{ registrations: ProviderRegistration[] }>(
    '/api/provider-registrations',
  )
  return data.registrations.map((r) => ({ ...r, health: r.health ?? UNKNOWN_HEALTH }))
}

export async function createProviderRegistration(
  input: CreateProviderRegistrationInput,
): Promise<ProviderRegistration> {
  const { data } = await axios.post<{ registration: ProviderRegistration }>(
    '/api/provider-registrations',
    input,
  )
  return { ...data.registration, health: data.registration.health ?? UNKNOWN_HEALTH }
}

export async function deleteProviderRegistration(id: string): Promise<void> {
  await axios.delete(`/api/provider-registrations/${encodeURIComponent(id)}`)
}

/** Fuerza una sonda ya, sin esperar el ciclo del monitor. Devuelve el health
 *  resultante — el server ya re-sincronizó el registry con él. */
export async function checkProviderRegistrationHealth(id: string): Promise<RemoteProviderHealth> {
  const { data } = await axios.post<{ health: RemoteProviderHealth }>(
    `/api/provider-registrations/${encodeURIComponent(id)}/health-check`,
  )
  return data.health
}
