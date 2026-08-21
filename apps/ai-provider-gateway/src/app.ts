// La API HTTP en sí — separada de src/index.ts (que solo la levanta con
// Bun.serve) para que los tests puedan llamar `app.request(...)` sin bindear
// un puerto real.
import type { IAgentProvider, ProviderInput } from '@ia-flow/ai-providers'
import { Hono } from 'hono'
import type { Log } from './logger.js'

export interface CreateAppDeps {
  provider: IAgentProvider
  /** Bearer token esperado en `Authorization: Bearer <token>`. `undefined`
   *  = servidor mal configurado — se rechaza todo (nunca "sin auth"). */
  token: string | undefined
  log: Log
}

function isProviderInput(body: unknown): body is ProviderInput {
  if (!body || typeof body !== 'object') return false
  const b = body as Record<string, unknown>
  return typeof b.taskId === 'string' && typeof b.prompt === 'string'
}

export function createApp({ provider, token, log }: CreateAppDeps): Hono {
  const app = new Hono()

  app.use('*', async (c, next) => {
    if (!token) {
      log.error({}, 'API_AI_PROVIDER_TOKEN no configurado — rechazando todo')
      return c.json({ error: 'server misconfigured: no auth token set' }, 500)
    }
    const header = c.req.header('authorization') ?? ''
    const provided = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
    if (provided !== token) return c.json({ error: 'unauthorized' }, 401)
    await next()
  })

  // GET /v1/provider — para que el registro del server principal valide que
  // esta instancia responde antes de guardar la registración. No expone un
  // "id" a elegir: cuál provider concreto corre acá es decisión interna de
  // esta instancia (ver providers.ts).
  app.get('/v1/provider', (c) => {
    return c.json({ kind: provider.kind, name: provider.name, description: provider.description })
  })

  app.post('/v1/run', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400)
    }
    if (!isProviderInput(body)) {
      return c.json({ error: 'body must be a ProviderInput (needs at least taskId, prompt)' }, 400)
    }

    try {
      const output = await provider.run(body)
      return c.json(output)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error({ err: message, taskId: body.taskId }, 'provider run failed')
      return c.json({ error: message }, 500)
    }
  })

  return app
}
