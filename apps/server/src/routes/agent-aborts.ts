// Runs de agente abortados por el upstream (stream stall / overload) que
// todavía no se resolvieron — ver Agent.ts (`upstream-abort`) y
// domain/ports/IAgentAbortRepository.ts. Lista lo que el barrido automático
// (daemon.ts) todavía no logró cerrar solo, y el botón "Reintentar" fuerza un
// retry ya, sin esperar el backoff.
import { Hono } from 'hono'
import { retryAbortRecord } from '../composition/actions.js'
import { agentAbortRepo } from '../composition/container.js'

export function createAgentAbortsRouter() {
  const router = new Hono()

  router.get('/', (c) => {
    const projectId = c.req.query('projectId') || undefined
    return c.json({ aborts: agentAbortRepo.list(projectId) })
  })

  router.post('/:id/retry', (c) => {
    const id = c.req.param('id')
    const record = agentAbortRepo.get(id)
    if (!record) return c.json({ error: `Abort '${id}' not found` }, 404)
    if (record.status === 'resolved') {
      return c.json({ error: `Abort '${id}' ya está resuelto` }, 409)
    }

    // Fire-and-forget: un run de agente dura minutos, y esperarlo acá
    // colgaría el request hasta que el proxy/axios cortan por timeout — el
    // mismo motivo por el que el barrido automático tampoco lo espera (ver
    // `retryAbortRecord` en composition/actions.ts). El resultado se ve
    // reapareciendo (o desapareciendo) en el próximo `GET /`.
    void retryAbortRecord(record)
    return c.json({ status: 'retrying' }, 202)
  })

  return router
}
