import { DomainEvent, type DomainEventScope } from './DomainEvent.js'

/**
 * Payload por `type` de DomainEvent — el punto único donde se documenta
 * "esto es lo que trae este evento", para que quien escribe un `do` (una
 * PipelineActionEntry registrada, un normalizador) no lea `event.payload` como
 * `Record<string, unknown>` a ciegas. NO acopla `DomainEvent`, que sigue
 * siendo genérico a propósito: un evento externo puede traer un `type` que
 * este catálogo todavía no declaró, y el engine (Pipeline.matches, Engine.dispatch,
 * Execution) nunca importa este archivo — sólo lo importa quien escribe
 * lógica concreta para un `type` puntual.
 *
 * Sólo entran acá los `type` que YA tienen un productor o consumidor real en
 * el código (mismo criterio que el resto de las entidades de esta sesión):
 * agregar 'slack.message.received' o 'github.issue.opened' antes de que
 * exista el adapter que los publique sería la misma scaffolding especulativa
 * que se descartó para Wait/IssueSource/StatusConfig — se agregan acá el
 * día que ese adapter se escriba, no antes.
 */
export interface EventCatalog {
  /** Lo publica AgentAction cuando `emitOn: 'exit'` y no hay `emitType`
   *  explícito (ver AgentAction.run). */
  'run.finished': {
    agentId: string
    taskId?: string
    outcome: string
    exit?: string
  }
  /** Dispara las Pipeline con `on: ['schedule.tick']` — CUÁNDO lo decide
   *  enteramente el generador externo (un cron); el engine no sabe qué
   *  expresión cron dispara esto, sólo que le llegó el evento. */
  'schedule.tick': {
    ruleId: string
  }
}

export type EventType = keyof EventCatalog

/**
 * Construir un DomainEvent con el payload catalogado — da inferencia
 * (`payload` tiene que tener la forma de `EventCatalog[T]`) sin que
 * `DomainEvent` mismo conozca el catálogo. Para un `type` NO catalogado
 * (un evento externo, o el `emitType` configurable de EmitAction) se sigue
 * usando `new DomainEvent(...)` directo — este helper es azúcar, no el
 * único camino.
 */
export function catalogedEvent<T extends EventType>(
  type: T,
  payload: EventCatalog[T],
  opts?: { id?: string; scope?: DomainEventScope; occurredAt?: Date; causationId?: string; depth?: number },
): DomainEvent<EventCatalog[T]> {
  return new DomainEvent(type, payload, opts)
}
