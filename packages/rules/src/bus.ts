// El bus de eventos — la indirección que separa "algo pasó" de "quién
// reacciona".
//
// Antes, `SourceDispatcher` llamaba directo a `TaskDispatcher.dispatch`: un
// solo destino cableado, que es la razón de que los eventos que no son de
// issues se descarten en el borde HTTP (ver ISSUE_EVENTS en routes/webhooks.ts
// — 41 deliveries de CI en 2 minutos, todos provocando un re-scan completo del
// board porque no había otro lugar a donde mandarlos). Con el bus, un evento se
// entrega sólo a quien lo pidió y el resto no cuesta nada.
//
// Vive en `@ia-flow/rules` y no en `apps/server/domain/ports` porque el
// publicador (`issue-sources`) y el handler (`agent-engine`) son dos paquetes
// que no pueden importar de la app. Es contrato + una implementación in-memory
// sin I/O, que es lo único que un bus in-process necesita.
import type { EngineEvent } from '@ia-flow/shared'
import { MAX_EVENT_DEPTH } from '@ia-flow/shared'

/**
 * Qué pasó con un evento.
 *
 * `skipped` = no había nada que hacer, o reintentar no cambiaría el resultado.
 * `deferred` = SÍ había trabajo pero no capacidad; el publicador tiene que
 * devolverlo al backlog y reintentarlo cuando se libere un slot.
 * `dispatched` = arrancó.
 *
 * Es el mismo tipo que `DispatchOutcome` de `@ia-flow/issue-sources`, que ahora
 * lo aliasea: son el mismo concepto y tener dos nombres divergentes sería una
 * forma silenciosa de que uno gane un caso que el otro no maneja.
 */
export type EventOutcome = 'dispatched' | 'skipped' | 'deferred'

export interface EventHandler {
  /** Para logs y para desregistrar. No tiene que ser único entre proyectos. */
  readonly id: string
  /** Pre-check barato y SIN I/O: tipo de evento y scope. Un `handles` que
   *  miente hacia el "sí" sólo cuesta una llamada de más; uno que miente hacia
   *  el "no" pierde el evento en silencio. */
  handles(event: EngineEvent): boolean
  handle(event: EngineEvent): Promise<EventOutcome>
}

export interface IEventBus {
  /** Suscribe un handler. Devuelve cómo darlo de baja — es lo que
   *  `reloadManagers` necesita para que un handler no sobreviva a lo que
   *  representa. */
  subscribe(handler: EventHandler): () => void
  /**
   * Entrega el evento a todos los handlers que lo aceptan y agrega sus
   * resultados.
   *
   * Devuelve un outcome —en vez de ser fire-and-forget como un bus de
   * libro— porque hoy el publicador lo necesita: `SourceDispatcher` decide con
   * él si el item vuelve al backlog. Cuando la cola de acciones persistida
   * exista, ese camino deja de necesitar la respuesta y esto puede aflojarse.
   */
  publish(event: EngineEvent): Promise<EventOutcome>
}

/** `deferred` gana sobre todo: significa "hay trabajo, reintentá", y perderlo
 *  detrás de un `skipped` de otro handler dejaría el item sin reintento hasta
 *  el próximo scan. `dispatched` gana sobre `skipped` por el mismo criterio de
 *  no subreportar trabajo real. */
export function aggregateOutcomes(outcomes: readonly EventOutcome[]): EventOutcome {
  if (outcomes.includes('deferred')) return 'deferred'
  if (outcomes.includes('dispatched')) return 'dispatched'
  return 'skipped'
}

export interface EventBusOptions {
  /** Se llama cuando un handler tira, o cuando un evento excede
   *  `MAX_EVENT_DEPTH`. Inyectado para no cablear un logger dentro de un
   *  paquete que se quiere puro y testeable sin nada levantado. */
  onError?: (err: unknown, context: { event: EngineEvent; handlerId?: string }) => void
  onDepthExceeded?: (event: EngineEvent) => void
  /**
   * ¿Ya se procesó este `event.id`?
   *
   * Es lo que hace que la identidad del evento sirva para algo. Los
   * productores que tienen identidad natural la usan: el `X-GitHub-Delivery`
   * de un webhook (GitHub reintenta), el `event_id` de Slack (Slack
   * reintenta), el minuto exacto de un tick de cron (dos barridos que se
   * solapan). Sin dedupe, cada uno de esos casos dispara las reglas dos veces.
   *
   * Marca Y consulta en la misma llamada —devuelve si YA estaba— para que dos
   * entregas concurrentes del mismo id no pasen las dos. Ausente = sin dedupe,
   * que es el comportamiento previo.
   */
  markProcessed?: (event: EngineEvent) => Promise<boolean>
  onDuplicate?: (event: EngineEvent) => void
}

export class InMemoryEventBus implements IEventBus {
  private readonly handlers = new Set<EventHandler>()

  constructor(private readonly opts: EventBusOptions = {}) {}

  subscribe(handler: EventHandler): () => void {
    this.handlers.add(handler)
    return () => {
      this.handlers.delete(handler)
    }
  }

  async publish(event: EngineEvent): Promise<EventOutcome> {
    // El tope de profundidad se aplica acá y no en cada productor: es el único
    // punto por el que pasan todos los eventos, incluidos los derivados por una
    // acción, que son los que pueden ciclar.
    if (event.depth > MAX_EVENT_DEPTH) {
      this.opts.onDepthExceeded?.(event)
      return 'skipped'
    }

    // El dedupe va ANTES de mirar los handlers: un duplicado no debería costar
    // ni siquiera la evaluación de los predicados.
    if (this.opts.markProcessed && (await this.opts.markProcessed(event))) {
      this.opts.onDuplicate?.(event)
      return 'skipped'
    }

    const matched: EventHandler[] = []
    for (const handler of this.handlers) {
      try {
        if (handler.handles(event)) matched.push(handler)
      } catch (err) {
        // Un `handles` roto descarta a SU handler, no al evento entero: el
        // resto de los suscriptores no tienen por qué pagar su bug.
        this.opts.onError?.(err, { event, handlerId: handler.id })
      }
    }
    if (!matched.length) return 'skipped'

    const results = await Promise.all(
      matched.map(async (handler): Promise<EventOutcome> => {
        try {
          return await handler.handle(event)
        } catch (err) {
          this.opts.onError?.(err, { event, handlerId: handler.id })
          // Un throw no es falta de capacidad: `skipped` suelta el item en vez
          // de reintentar en loop un error que no se arregla solo. Mismo
          // criterio que tenía el catch de `startAll` en daemon.ts.
          return 'skipped'
        }
      }),
    )
    return aggregateOutcomes(results)
  }
}
