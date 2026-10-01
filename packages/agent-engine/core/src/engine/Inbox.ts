import type { DomainEvent } from '../events/DomainEvent.js'

interface Delivered {
  message: string
  /** Sin evento: un aviso del engine (ej. que la interrumpieron), no algo para re-despachar. */
  event?: DomainEvent<any>
  read: boolean
}

/**
 * Lo que le llega a una ejecución mientras corre. `deliver`: lo aceptó su paso activo y lo lee en
 * su próxima vuelta (`drain`); lo que nadie leyó queda para `takeUnread`. `notify`: un aviso del
 * engine que el paso activo lee igual, pero que no es un evento — sin leer, no se re-despacha.
 * `miss`: ningún paso lo aceptó, pero puede ser justo lo que su pausa espera (`takeMissed`).
 */
export class Inbox {
  private readonly delivered: Delivered[] = []
  private missed: DomainEvent<any>[] = []

  deliver(message: string, event: DomainEvent<any>): void {
    this.delivered.push({ message, event, read: false })
  }

  notify(message: string): void {
    this.delivered.push({ message, read: false })
  }

  miss(event: DomainEvent<any>): void {
    this.missed.push(event)
  }

  /** Lo que llegó desde la última vez, en orden — y lo marca leído. */
  drain(): string[] {
    return this.takeFresh().map((entry) => entry.message)
  }

  /** Lo entregado que nadie leyó — y lo consume: se toma una sola vez. */
  takeUnread(): DomainEvent<any>[] {
    return this.takeFresh().flatMap((entry) => (entry.event ? [entry.event] : []))
  }

  /** Lo que nadie aceptó, en orden — y lo olvida. */
  takeMissed(): DomainEvent<any>[] {
    const missed = this.missed
    this.missed = []
    return missed
  }

  private takeFresh(): Delivered[] {
    const fresh = this.delivered.filter((entry) => !entry.read)
    for (const entry of fresh) entry.read = true
    return fresh
  }
}
