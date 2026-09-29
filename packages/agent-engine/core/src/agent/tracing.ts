/**
 * Qué deja `Agent` en la traza — lo usan los decorators de `Agent.ts`.
 */
import type { TagOptions } from '@ia-flow/telemetry'
import type { ExecutionHandle } from '../pipeline/Runnable.js'
import type { Agent } from './Agent.js'

/**
 * Cuándo el agente leyó lo que se le inyectó (sus `injects`): un span event `inbox.delivered`
 * en el span activo (el del agente, o el de la vuelta del provider) y un log. Del lado del
 * evento, `execution.inject` dice a qué ejecución y a qué agente se entregó; esto
 * cierra el recorrido. Una vuelta sin nada nuevo no deja nada.
 */
export const inboxTag: TagOptions<Agent, [ExecutionHandle], string[]> = {
  onResult(span, messages, execution) {
    if (messages.length === 0) return
    span.addEvent('inbox.delivered', {
      'ia.inbox.count': messages.length,
      'ia.execution.id': execution.id,
    })
    this.log.info(`agente ${this.id} leyó ${messages.length} mensaje(s) inyectado(s)`, {
      'ia.execution.id': execution.id,
    })
  },
}
