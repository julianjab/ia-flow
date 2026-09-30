/**
 * Qué deja `Agent` en la traza — lo usan los decorators de `Agent.ts`.
 */
import type { TagOptions } from '@ia-flow/telemetry'
import type { ExecutionHandle } from '../pipeline/Runnable.js'
import type { Agent } from './Agent.js'
import type { SelectedProvider } from './ProviderSelector.js'

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

/** En qué provider corrió el agente (`ia.agent.provider`), y los candidatos que se saltearon y
 *  por qué — sin lugar, no lo acepta, o no es elegible para el evento. */
export const providerTag: TagOptions<Agent, [SelectedProvider], SelectedProvider> = {
  onResult(span, selected) {
    span.setAttribute('ia.agent.provider', selected.candidate.id)
    if (selected.skipped.length > 0) {
      span.setAttribute('ia.agent.providers_skipped', selected.skipped)
    }
    if (this.candidates.length > 1) {
      this.log.info(
        `agente ${this.id} corre en ${selected.candidate.id}${selected.skipped.length > 0 ? ` (salteó: ${selected.skipped.join('; ')})` : ''}`,
      )
    }
  },
}
