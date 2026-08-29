// Lógica pura de routes/provider-registrations.ts, separada para poder
// testearla sin arrastrar composition/container.js (que abre una conexión
// SQLite real como efecto lateral de importarse) — mismo patrón que
// routes/agents-crud-validation.ts.
import { z } from 'zod'
import type { ProviderRegistration } from '../domain/ports/IProviderRegistrationRepository.js'

// `name` se persiste como `id` (ver routes/provider-registrations.ts) y
// queda expuesto tal cual en `provider: remote:<name>` dentro de un
// AgentDefinition — restringido a lo que ya usan los demás ids del repo
// (slug: minúsculas, números, guiones) para que sea seguro pegarlo en YAML
// o en la URL de `DELETE /:id` sin escapar nada.
export const RegistrationInputSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'name debe ser un slug: minúsculas, números y guiones'),
  baseUrl: z.string().url(),
  token: z.string().min(1),
})

/** `id` de una registración = su `name` (ver routes/provider-registrations.ts,
 *  POST /) — devuelve el mensaje de error si ese `name` ya está en uso,
 *  o `null` si no hay conflicto. Toma el `Set` de ids existentes en vez del
 *  repo directo — mismo patrón que `repoNameError`
 *  (routes/agents-crud-validation.ts) para poder testearlo sin DB real. */
export function duplicateNameError(name: string, existingIds: Set<string>): string | null {
  if (!existingIds.has(name)) return null
  return `Registration '${name}' already exists — delete it first`
}

export interface AgentHostProviderEntry {
  kind: 'sync' | 'async'
  name: string
  description: string
}

/** Le pide al agent-host que describa el provider que expone. No lanza — el
 *  caller decide qué HTTP status usar según el motivo. */
export async function fetchAgentHostProvider(
  baseUrl: string,
  token: string,
): Promise<{ ok: true; entry: AgentHostProviderEntry } | { ok: false; error: string }> {
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
  const entry = (await res.json().catch(() => null)) as AgentHostProviderEntry | null
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
