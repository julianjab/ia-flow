import type { DomainEvent } from '../events/DomainEvent.js'

/** Quién lee el inbox: un paso activo. Se compara por identidad. */
export type InboxReader = object

/** El lector implícito de `drain()` sin argumentos: lee todo, y por eso marca todo leído. */
const EVERYONE: InboxReader = {}

interface Delivered {
  message: string
  /** Sin evento: un aviso del engine (ej. que la interrumpieron), no algo para re-despachar. */
  event?: DomainEvent<any>
  /** Para quiénes es. Sin destinatarios: para cualquier lector. */
  to?: readonly InboxReader[]
  /** Quiénes ya la leyeron. */
  readBy: Set<InboxReader>
}

/**
 * Lo que le llega a una ejecución mientras corre. `deliver`: lo aceptó un paso activo y lo lee en
 * su próxima vuelta (`drain`); lo que nadie leyó queda para `takeUnread`. `notify`: un aviso del
 * engine que el paso lee igual, pero que no es un evento — sin leer, no se re-despacha. `miss`:
 * ningún paso lo aceptó, pero puede ser justo lo que su pausa espera (`takeMissed`).
 *
 * **Cada entrega tiene destinatarios.** Una ejecución puede tener varios pasos activos a la vez (un
 * grupo `parallel`): si compartieran una sola bandeja, el primero que la vaciara se llevaría lo de
 * los demás. Un evento que aceptan dos pasos es UNA entrega para los dos; `drain(reader)` lee lo
 * suyo, y lo que uno leyó lo sigue viendo el otro. `drain()` sin lector lee todo — el caso de un
 * solo paso, que es el de siempre.
 */
export class Inbox {
  private readonly delivered: Delivered[] = []
  private missed: DomainEvent<any>[] = []

  deliver(message: string, event: DomainEvent<any>, to?: readonly InboxReader[]): void {
    this.delivered.push({ message, event, readBy: new Set(), ...(to ? { to } : {}) })
  }

  notify(message: string, to?: readonly InboxReader[]): void {
    this.delivered.push({ message, readBy: new Set(), ...(to ? { to } : {}) })
  }

  miss(event: DomainEvent<any>): void {
    this.missed.push(event)
  }

  /** Lo que llegó para `reader` desde la última vez, en orden — y lo marca leído por él. Sin
   *  `reader`, todo lo que nadie leyó todavía. */
  drain(reader?: InboxReader): string[] {
    const fresh = this.delivered.filter((entry) =>
      reader
        ? !entry.readBy.has(reader) && (!entry.to || entry.to.includes(reader))
        : entry.readBy.size === 0,
    )
    for (const entry of fresh) entry.readBy.add(reader ?? EVERYONE)
    return fresh.map((entry) => entry.message)
  }

  /**
   * Los eventos entregados que NADIE leyó — y los consume: se toman una sola vez. Una entrega para
   * dos pasos donde uno sí la leyó no vuelve: re-despacharla correría otra vez por las reglas algo
   * que un agente ya atendió.
   */
  takeUnread(): DomainEvent<any>[] {
    const unread: DomainEvent<any>[] = []
    for (const entry of this.delivered) {
      if (entry.readBy.size > 0) continue
      entry.readBy.add(EVERYONE)
      if (entry.event) unread.push(entry.event)
    }
    return unread
  }

  /** Lo que nadie aceptó, en orden — y lo olvida. */
  takeMissed(): DomainEvent<any>[] {
    const missed = this.missed
    this.missed = []
    return missed
  }
}
