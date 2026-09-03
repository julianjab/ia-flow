// Runs de agente abortados por el upstream (stream stall / overload) que
// todavía no se resolvieron — ver Agent.ts (`upstream-abort`) y
// domain/ports/IAgentAbortRepository.ts. Lista lo que el barrido automático
// (daemon.ts) todavía no logró cerrar solo, y el botón "Reintentar" fuerza un
// retry ya, sin esperar el backoff.
import { Hono } from 'hono'
import { redispatchAborted } from '../composition/actions.js'
import { agentAbortRepo } from '../composition/container.js'

export function createAgentAbortsRouter() {
  const router = new Hono()

  router.get('/', (c) => {
    const projectId = c.req.query('projectId') || undefined
    return c.json({ aborts: agentAbortRepo.list(projectId) })
  })

  router.post('/:id/retry', async (c) => {
    const id = c.req.param('id')
    const record = agentAbortRepo.get(id)
    if (!record) return c.json({ error: `Abort '${id}' not found` }, 404)
    if (record.status === 'resolved') {
      return c.json({ error: `Abort '${id}' ya está resuelto` }, 409)
    }

    // Limpia `nextRetryAt` para que el barrido no lo tome también mientras
    // este dispatch manual está en vuelo.
    agentAbortRepo.markRetrying(id)
    const result = await redispatchAborted(record)
    if (!result.ok) return c.json({ error: result.reason }, 502)
    return c.json({ outcome: result.outcome })
  })

  return router
}
