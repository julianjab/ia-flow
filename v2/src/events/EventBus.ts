import type { DomainEvent } from './DomainEvent.js'

export type EventHandler = (event: DomainEvent) => void | Promise<void>
export type Unsubscribe = () => void

/** Pub/sub in-process. El Engine se suscribe a '*' para evaluar Pipelines contra todo lo que pasa;
 *  handlers puntuales (ej. WaitHandler en v1) se suscriben a tipos concretos. */
export class EventBus {
  private readonly handlers = new Map<string, Set<EventHandler>>()

  subscribe(type: string, handler: EventHandler): Unsubscribe {
    const set = this.handlers.get(type) ?? new Set<EventHandler>()
    set.add(handler)
    this.handlers.set(type, set)
    return () => {
      this.handlers.get(type)?.delete(handler)
    }
  }

  /** No espera a los handlers (fire-and-forget) — un handler async que falla
   *  no puede tumbar al que publicó el evento; loguear el rechazo queda del
   *  lado de cada handler. */
  publish(event: DomainEvent): void {
    for (const handler of this.handlers.get(event.type) ?? []) {
      void handler(event)
    }
    if (event.type !== '*') {
      for (const handler of this.handlers.get('*') ?? []) {
        void handler(event)
      }
    }
  }
}
