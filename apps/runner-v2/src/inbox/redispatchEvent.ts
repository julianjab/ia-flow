import { createEvent, type DomainEvent } from '@ia-flow/agent-engine'
import type { StoredEvent } from './ActivityPort.js'

/**
 * El evento que relanza una task: el último que se le despachó, con su MISMO scope. El scope es la
 * clave de la ejecución (`scopeExecutionKey`): con algo más —quién relanzó— la task tenía dos
 * claves y un webhook que llegaba mientras tanto arrancaba una segunda corrida en paralelo sobre el
 * mismo worktree (lh-seller-v2-frontend#4381). Quién relanzó va al log, no acá.
 */
export function redispatchEvent(last: StoredEvent): DomainEvent<unknown> {
  return createEvent(last.type, last.payload, {
    ...(last.scope ? { scope: last.scope } : {}),
    parentId: last.id,
  })
}
