// CRUD de providers remotos (instancias de apps/ai-provider-gateway) — ver
// domain/ports/IProviderRegistrationRepository.ts y
// adapters/remote-provider/RemoteAgentProvider.ts.
import { Hono } from 'hono'
import { z } from 'zod'
import {
  RemoteAgentProvider,
  remoteProviderId,
} from '../adapters/remote-provider/RemoteAgentProvider.js'
import { providerRegistrationRepo, providerRegistry } from '../composition/container.js'
import type { ProviderRegistration } from '../domain/ports/IProviderRegistrationRepository.js'

const RegistrationInputSchema = z.object({
  name: z.string().min(1),
  baseUrl: z.string().url(),
  providerId: z.string().min(1),
  token: z.string().min(1),
})

interface GatewayProviderEntry {
  id: string
  kind: 'sync' | 'async'
  name: string
  description: string
}

/** Le pide al gateway su listado de providers y devuelve la entry que
 *  coincide con `providerId`, o `null` si no responde / no la tiene. No
 *  lanza — el caller decide qué HTTP status usar según el motivo. */
async function fetchGatewayProvider(
  baseUrl: string,
  token: string,
  providerId: string,
): Promise<{ ok: true; entry: GatewayProviderEntry } | { ok: false; error: string }> {
  let res: Response
  try {
    res = await fetch(`${baseUrl}/v1/providers`, {
      headers: { authorization: `Bearer ${token}` },
    })
  } catch (err) {
    return { ok: false, error: `no se pudo alcanzar ${baseUrl}: ${(err as Error).message}` }
  }
  if (!res.ok) {
    return { ok: false, error: `${baseUrl} respondió ${res.status} al listar providers` }
  }
  const body = (await res.json().catch(() => null)) as { providers?: GatewayProviderEntry[] } | null
  const entry = body?.providers?.find((p) => p.id === providerId)
  if (!entry) {
    return {
      ok: false,
      error: `'${providerId}' no está entre los providers que expone ${baseUrl}`,
    }
  }
  return { ok: true, entry }
}

// Nunca devuelve `token` en las respuestas — solo si está seteado, para que
// la UI pueda mostrar "configurado" sin exponer el secreto.
function toPublicRegistration(r: ProviderRegistration) {
  const { token, ...rest } = r
  return { ...rest, hasToken: token.length > 0 }
}

export function createProviderRegistrationsRouter() {
  const router = new Hono()

  router.get('/', (c) => {
    return c.json({ registrations: providerRegistrationRepo.list().map(toPublicRegistration) })
  })

  router.post('/', async (c) => {
    const parsed = RegistrationInputSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400)
    const { name, baseUrl, providerId, token } = parsed.data

    const gateway = await fetchGatewayProvider(baseUrl, token, providerId)
    if (!gateway.ok) return c.json({ error: gateway.error }, 400)

    const registration: ProviderRegistration = {
      id: crypto.randomUUID(),
      name,
      baseUrl,
      remoteProviderId: providerId,
      token,
      remoteKind: gateway.entry.kind,
      remoteName: gateway.entry.name,
      remoteDescription: gateway.entry.description,
      createdAt: new Date().toISOString(),
    }
    providerRegistrationRepo.insert(registration)
    providerRegistry.register(new RemoteAgentProvider(registration))

    return c.json({ registration: toPublicRegistration(registration) }, 201)
  })

  router.delete('/:id', (c) => {
    const id = c.req.param('id')
    if (!providerRegistrationRepo.get(id)) {
      return c.json({ error: `Registration '${id}' not found` }, 404)
    }
    providerRegistrationRepo.deleteById(id)
    providerRegistry.unregister(remoteProviderId(id))
    return c.json({ ok: true })
  })

  return router
}
