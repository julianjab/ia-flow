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
  /**
   * Cuántos runs simultáneos acepta esta instancia. `undefined` o `<= 0` =
   * sin límite (mismo criterio que los caps del server, ver capacity.ts en
   * @ia-flow/agent-engine).
   *
   * Este es el único lugar que conoce la ocupación REAL del gateway: un
   * mismo gateway puede estar registrado en varios daemons, y el cap que
   * cada daemon lleva por su cuenta (`ProviderConfig.providerLimits`) sólo
   * cuenta lo que despachó él. Por eso acá se enforcea de verdad (503 en
   * /v1/run) además de publicarse en /v1/capacity para que el daemon pueda
   * enrutar a otro provider antes de intentar.
   */
  maxConcurrentRuns?: number
}

function isProviderInput(body: unknown): body is ProviderInput {
  if (!body || typeof body !== 'object') return false
  const b = body as Record<string, unknown>
  return typeof b.taskId === 'string' && typeof b.prompt === 'string'
}

export function createApp({ provider, token, log, maxConcurrentRuns }: CreateAppDeps): Hono {
  const app = new Hono()

  // Runs en vuelo en ESTE proceso. Se incrementa al entrar a /v1/run y se
  // libera en un finally, así un provider que lanza no deja el contador
  // envenenado.
  let running = 0
  const unlimited = maxConcurrentRuns == null || maxConcurrentRuns <= 0
  const accepting = () => unlimited || running < (maxConcurrentRuns as number)

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

  // GET /v1/capacity — sonda barata para que el daemon sepa, ANTES de
  // mandar el run, si esta instancia puede tomarlo. Consultiva: no reserva
  // nada (ver IAgentProvider.canAccept). La decisión firme es el 503 de
  // /v1/run.
  app.get('/v1/capacity', (c) => {
    return c.json({
      running,
      maxConcurrentRuns: unlimited ? null : maxConcurrentRuns,
      accepting: accepting(),
    })
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

    // Saturado: 503, no 500. Es "volvé después", no "esto falló" — el
    // daemon lo difiere y reintenta cuando se libera un slot, en vez de
    // marcar el run como error.
    if (!accepting()) {
      log.warn({ running, maxConcurrentRuns, taskId: body.taskId }, 'gateway saturado — 503')
      return c.json({ error: 'gateway at capacity', running, maxConcurrentRuns }, 503)
    }

    running++
    try {
      const output = await provider.run(body)
      return c.json(output)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error({ err: message, taskId: body.taskId }, 'provider run failed')
      return c.json({ error: message }, 500)
    } finally {
      running--
    }
  })

  return app
}
