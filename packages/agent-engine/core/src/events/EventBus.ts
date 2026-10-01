import type { DomainEvent } from './DomainEvent.js'

/**
 * Devuelve `unknown` (no `void`) a propósito: un handler puede devolver algo con sentido
 * propio (`Engine.dispatch` devuelve `DispatchOutcome`) y `publish` no lo mira — sólo
 * necesita poder esperar la promesa si el handler devuelve una. `void` acá bloquearía esa
 * devolución (TS no aplica su regla de "cualquier cosa cae en void" adentro de un `Promise<T>`).
 */
export type EventHandler = (event: DomainEvent<any>) => unknown
export type Unsubscribe = () => void

/**
 * Pub/sub in-process. No persiste nada y no garantiza orden entre suscriptores
 * distintos — sólo desacopla "quién publica" de "quién reacciona" (Engine, loggers,
 * integraciones ad-hoc). Cada app que use esta lib trae su propio conector de entrada
 * (webhook de GitHub, Socket Mode de Slack, un cron) que traduce a `DomainEvent` y publica acá.
 */
export class EventBus {
  private readonly handlers = new Map<string, Set<EventHandler>>()

  subscribe(type: string | '*', handler: EventHandler): Unsubscribe {
    const set = this.handlers.get(type) ?? new Set()
    set.add(handler)
    this.handlers.set(type, set)
    return () => {
      set.delete(handler)
    }
  }

  /** Corre los handlers de `event.type` y los de '*' — en paralelo, sin cortar en el primer error. */
  async publish(event: DomainEvent<any>): Promise<void> {
    const handlers = [...(this.handlers.get(event.type) ?? []), ...(this.handlers.get('*') ?? [])]
    // `Promise.resolve().then(...)` — no `handler(event)` directo — porque un handler SÍNCRONO
    // que tira (no uno que devuelve una promesa rechazada) escaparía del `.map` antes de
    // llegar a `Promise.allSettled`, y ese throw cortaría a los demás handlers en vez de
    // quedar aislado como cualquier otro rechazo.
    const results = await Promise.allSettled(
      handlers.map((handler) => Promise.resolve().then(() => handler(event))),
    )
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        `${failures.length} handler(s) failed for event "${event.type}"`,
      )
    }
  }
}
