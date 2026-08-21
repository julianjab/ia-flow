// CRUD de providers remotos (instancias de apps/ai-provider-gateway) — ver
// domain/ports/IProviderRegistrationRepository.ts,
// adapters/remote-provider/RemoteAgentProvider.ts y
// provider-registrations-logic.ts (la parte testeable sin DB real).
import { Hono } from 'hono'
import {
  RemoteAgentProvider,
  remoteProviderId,
} from '../adapters/remote-provider/RemoteAgentProvider.js'
import { providerRegistrationRepo, providerRegistry } from '../composition/container.js'
import type { ProviderRegistration } from '../domain/ports/IProviderRegistrationRepository.js'
import {
  RegistrationInputSchema,
  fetchGatewayProvider,
  toPublicRegistration,
} from './provider-registrations-logic.js'

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
