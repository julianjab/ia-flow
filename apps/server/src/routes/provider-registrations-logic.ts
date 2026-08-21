// Lógica pura de routes/provider-registrations.ts, separada para poder
// testearla sin arrastrar composition/container.js (que abre una conexión
// SQLite real como efecto lateral de importarse) — mismo patrón que
// routes/agents-crud-validation.ts.
import { z } from 'zod'
import type { ProviderRegistration } from '../domain/ports/IProviderRegistrationRepository.js'

export const RegistrationInputSchema = z.object({
  name: z.string().min(1),
  baseUrl: z.string().url(),
  token: z.string().min(1),
})

export interface GatewayProviderEntry {
  kind: 'sync' | 'async'
  name: string
  description: string
}

/** Le pide al gateway que describa el provider que expone. No lanza — el
 *  caller decide qué HTTP status usar según el motivo. */
export async function fetchGatewayProvider(
  baseUrl: string,
  token: string,
): Promise<{ ok: true; entry: GatewayProviderEntry } | { ok: false; error: string }> {
  let res: Response
  try {
    res = await fetch(`${baseUrl}/v1/provider`, {
      headers: { authorization: `Bearer ${token}` },
    })
  } catch (err) {
    return { ok: false, error: `no se pudo alcanzar ${baseUrl}: ${(err as Error).message}` }
  }
  if (!res.ok) {
    return { ok: false, error: `${baseUrl} respondió ${res.status} al describir su provider` }
  }
  const entry = (await res.json().catch(() => null)) as GatewayProviderEntry | null
  if (!entry || typeof entry.kind !== 'string') {
    return { ok: false, error: `${baseUrl} no devolvió un provider válido` }
  }
  return { ok: true, entry }
}

// Nunca devuelve `token` en las respuestas — solo si está seteado, para que
// la UI pueda mostrar "configurado" sin exponer el secreto.
export function toPublicRegistration(r: ProviderRegistration) {
  const { token, ...rest } = r
  return { ...rest, hasToken: token.length > 0 }
}
