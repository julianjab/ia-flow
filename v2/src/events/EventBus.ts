import type { DomainEvent } from './DomainEvent.js'

export type EventHandler = (event: DomainEvent) => void | Promise<void>
export type Unsubscribe = () => void

/** Pub/sub in-process. El Engine se suscribe a '*' para evaluar Rules contra todo lo que pasa;
 *  handlers puntuales (ej. WaitHandler en v1) se suscriben a tipos concretos. */
export class EventBus {
  private readonly handlers = new Map<string, Set<EventHandler>>()

  subscribe(type: string, handler: EventHandler): Unsubscribe {
    throw new Error('not implemented')
  }

  publish(event: DomainEvent): void {
    throw new Error('not implemented — despacha a los handlers de event.type y a los de "*"')
  }
}
