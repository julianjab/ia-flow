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
  duplicateNameError,
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
    const { name, baseUrl, token } = parsed.data

    // `id` = `name`, no un UUID random: así el `provider: remote:<id>` que
    // se declara en un agente es predecible (`remote:julianbuitrago-mac`,
    // no un UUID que cambia en cada re-registro) y estable entre reinicios
    // del gateway — registerSelf() (apps/ai-provider-gateway/src/register.ts)
    // borra la fila vieja con el mismo name antes de crear la nueva
    // justamente para poder asumir esta estabilidad.
    const existingIds = new Set(providerRegistrationRepo.list().map((r) => r.id))
    const dupErr = duplicateNameError(name, existingIds)
    if (dupErr) return c.json({ error: dupErr }, 409)

    const gateway = await fetchGatewayProvider(baseUrl, token)
    if (!gateway.ok) return c.json({ error: gateway.error }, 400)

    const registration: ProviderRegistration = {
      id: name,
      name,
      baseUrl,
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
