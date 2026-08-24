// CRUD de providers remotos (instancias de apps/ai-provider-gateway) — ver
// domain/ports/IProviderRegistrationRepository.ts,
// adapters/remote-provider/RemoteAgentProvider.ts y
// provider-registrations-logic.ts (la parte testeable sin DB real).
import { Hono } from 'hono'
import {
  RemoteAgentProvider,
  remoteProviderId,
} from '../adapters/remote-provider/RemoteAgentProvider.js'
import {
  providerRegistrationRepo,
  providerRegistry,
  remoteProviderHealth,
} from '../composition/container.js'
import type { ProviderRegistration } from '../domain/ports/IProviderRegistrationRepository.js'
import {
  RegistrationInputSchema,
  duplicateNameError,
  fetchGatewayProvider,
  toPublicRegistration,
} from './provider-registrations-logic.js'

export function createProviderRegistrationsRouter() {
  const router = new Hono()

  // Lista SIEMPRE todas las registraciones, sanas o no — a diferencia de
  // GET /api/providers (que sólo ve lo registrado, o sea lo sano). Es acá
  // donde el operador ve que un remoto desapareció de los elegibles y por qué.
  router.get('/', (c) => {
    return c.json({
      registrations: providerRegistrationRepo
        .list()
        .map((r) => ({ ...toPublicRegistration(r), health: remoteProviderHealth.get(r.id) })),
    })
  })

  // POST /:id/health-check — sondea ya, sin esperar el próximo ciclo. Además
  // de mostrar el resultado, re-sincroniza el registry: es la forma de
  // recuperar un remoto apenas se levanta su gateway.
  router.post('/:id/health-check', async (c) => {
    const id = c.req.param('id')
    const registration = providerRegistrationRepo.get(id)
    if (!registration) return c.json({ error: `Registration '${id}' not found` }, 404)
    const health = await remoteProviderHealth.checkOne(registration)
    return c.json({ health })
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
    // Sano por construcción: `fetchGatewayProvider` acaba de hablarle. Se
    // siembra el health para que el monitor no lo vea `unknown` y lo trate
    // como caído hasta su primera ronda.
    remoteProviderHealth.markHealthy(registration.id)
    providerRegistry.register(new RemoteAgentProvider(registration))

    return c.json(
      {
        registration: {
          ...toPublicRegistration(registration),
          health: remoteProviderHealth.get(registration.id),
        },
      },
      201,
    )
  })

  router.delete('/:id', (c) => {
    const id = c.req.param('id')
    if (!providerRegistrationRepo.get(id)) {
      return c.json({ error: `Registration '${id}' not found` }, 404)
    }
    providerRegistrationRepo.deleteById(id)
    providerRegistry.unregister(remoteProviderId(id))
    remoteProviderHealth.forget(id)
    return c.json({ ok: true })
  })

  return router
}
