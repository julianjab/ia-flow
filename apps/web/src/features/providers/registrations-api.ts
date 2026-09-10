import type { RemoteProviderHealth, SystemPromptDef, SystemPromptRef } from '@ia-flow/shared'
import { SystemPromptDefSchema } from '@ia-flow/shared'
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
  /** Bloque ADICIONAL a los que ya arma cada agente — describe cómo correr
   *  específicamente en ESTE gateway. Ver
   *  domain/ports/IProviderRegistrationRepository.ts. */
  systemPrompt: SystemPromptRef | null
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
  systemPrompt?: SystemPromptRef | null
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

/** Catálogo GLOBAL de system prompts (General → System Prompts) — un provider
 *  registrado no está scoped a un proyecto, así que no tiene sentido ofrecer
 *  los de un proyecto puntual acá. Esta feature hace su propia llamada en vez
 *  de importar la de `project-config`: una feature no importa a otra (ver el
 *  CLAUDE.md de apps/web). */
export async function listGlobalSystemPrompts(): Promise<SystemPromptDef[]> {
  const { data } = await axios.get<{ systemPrompts: unknown[] }>('/api/system-prompts?scope=global')
  return data.systemPrompts.map((sp) => SystemPromptDefSchema.parse(sp))
}

export async function updateProviderRegistrationSystemPrompt(
  id: string,
  systemPrompt: SystemPromptRef | null,
): Promise<ProviderRegistration> {
  const { data } = await axios.put<{ registration: ProviderRegistration }>(
    `/api/provider-registrations/${encodeURIComponent(id)}/system-prompt`,
    { systemPrompt },
  )
  return { ...data.registration, health: data.registration.health ?? UNKNOWN_HEALTH }
}

/** Fuerza una sonda ya, sin esperar el ciclo del monitor. Devuelve el health
 *  resultante — el server ya re-sincronizó el registry con él. */
export async function checkProviderRegistrationHealth(id: string): Promise<RemoteProviderHealth> {
  const { data } = await axios.post<{ health: RemoteProviderHealth }>(
    `/api/provider-registrations/${encodeURIComponent(id)}/health-check`,
  )
  return data.health
}
