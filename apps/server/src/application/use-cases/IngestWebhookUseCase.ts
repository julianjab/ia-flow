import type { EventOutcome } from '@ia-flow/rules'
import type { IEventBus } from '../../domain/ports/IEventBus.js'
import type { IWebhookTranslator, WebhookDelivery } from '../../domain/ports/IWebhookTranslator.js'

export type IngestWebhookResult =
  | { status: 'ignored'; reason: 'no-translator' | 'no-event' }
  | { status: 'published'; type: string; outcome: EventOutcome }

/**
 * Convierte un delivery ya verificado en un evento del bus.
 *
 * Vive acá y no en la ruta porque es una DECISIÓN —qué traductor aplica, y qué
 * significa que ninguno lo haga— no una traducción HTTP. La ruta se queda con
 * lo suyo: leer el body crudo, verificar la firma, y mapear el resultado a un
 * status code. Ése es también el motivo por el que un traductor nuevo (Linear,
 * Sentry) no toca la ruta: se agrega a la lista en `composition/container.ts`.
 *
 * La distinción entre los dos "ignorado" no es cosmética. `no-translator`
 * significa que nadie en este proceso entiende ese tipo de delivery —lo que
 * responde "¿por qué no pasa nada cuando suscribo este evento en el hook?"— y
 * `no-event` que sí se entendió pero no había nada que publicar.
 */
export class IngestWebhookUseCase {
  constructor(
    private readonly translators: readonly IWebhookTranslator[],
    private readonly bus: IEventBus,
  ) {}

  /** ¿Alguien entiende este tipo de delivery? Lo consulta el borde para
   *  descartar temprano, sin parsear el body. */
  handles(event: string): boolean {
    return this.translators.some((t) => t.handles(event))
  }

  async ingest(delivery: WebhookDelivery): Promise<IngestWebhookResult> {
    const translator = this.translators.find((t) => t.handles(delivery.event))
    if (!translator) return { status: 'ignored', reason: 'no-translator' }

    const event = translator.translate(delivery)
    if (!event) return { status: 'ignored', reason: 'no-event' }

    return { status: 'published', type: event.type, outcome: await this.bus.publish(event) }
  }
}
