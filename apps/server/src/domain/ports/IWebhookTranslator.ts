import type { IssueItem } from '@ia-flow/issue-sources'
import type { EngineEvent } from '@ia-flow/shared'

export interface WebhookDelivery {
  /** El tipo que declara la fuente: `pull_request`, `event_callback`, … */
  event: string
  payload: Record<string, unknown>
  /** El id del delivery, cuando la fuente manda uno (`X-GitHub-Delivery`, el
   *  `event_id` de Slack). Es lo que hace idempotente un reintento. */
  deliveryId?: string
  /** El trace del REQUEST HTTP que trajo este delivery — generado en el borde
   *  (`routes/webhooks.ts`), ANTES de verificar la firma, así que existe aun
   *  para un delivery que termina rechazado. Para GitHub es `deliveryId`
   *  (mismo id en un reintento); para Slack (sin ese header) es un
   *  `crypto.randomUUID()` por request. Distinto de `deliveryId` en propósito:
   *  éste es sólo trazabilidad, nunca una clave de dedupe. */
  traceId?: string
  /**
   * Proyecto(s) de ia-flow que ya matchearon este delivery, cuando la RUTA ya
   * lo sabe de otra fuente — hoy sólo `projects_v2_item`/`projects_v2`, cuyo
   * payload no trae `owner/repo` (no hay `ScopeResolver` posible) pero SÍ pasa
   * por `deliverWebhook`/`webhook-registry` antes de llegar acá, que ya hace
   * el match por `project_node_id`. La ruta lo completa; el translator no lo
   * calcula — evita resolver la MISMA pregunta dos veces con dos mecanismos
   * distintos.
   */
  projectIds?: string[]
}

/**
 * Traduce el delivery de UN sistema externo a un evento del engine.
 *
 * Vive en `domain/ports/` y no junto al caso de uso porque lo implementan los
 * adapters (`adapters/github/`, y `@ia-flow/slack` desde afuera): si la interfaz viviera en
 * `application/`, cada adapter tendría que importar hacia adentro de una capa
 * que no le corresponde. Así las dos puntas —el caso de uso que la consume y
 * el adapter que la cumple— apuntan al mismo centro.
 *
 * Un traductor es **puro**: no consulta la DB ni la red. Lo que necesita del
 * mundo (resolver `owner/repo` → proyecto) lo recibe por constructor, que es
 * lo que permite testear la forma del evento sin levantar nada.
 */
export interface IWebhookTranslator {
  /** Para logs y diagnóstico. */
  readonly source: string

  /** ¿Este tipo de delivery le corresponde? Se llama por cada delivery,
   *  incluidos los que nadie quiere, así que no puede hacer I/O. */
  handles(event: string): boolean

  /** El evento, o `null` si este delivery no produce ninguno: una acción que
   *  no interesa, un mensaje de bot, un payload incompleto. Devolver `null` en
   *  vez de un evento vacío es lo que evita que cada regla tenga que filtrar
   *  ruido que el borde ya sabía descartar. */
  translate(delivery: WebhookDelivery): EngineEvent | null

  /**
   * Resuelve a qué `IssueItem` de negocio pertenece este evento, cuando la
   * fuente puede — así una regla con acción `agent` puede correr sobre él sin
   * que el evento haya nacido del scan.
   *
   * Vive aparte de `translate` porque `translate` tiene que seguir siendo
   * puro y sync; esto necesita ir a buscar el item (1 fetch puntual, nunca un
   * scan). Opcional: sin implementar, o si devuelve `null`/tira, el evento se
   * publica igual, sin `item` — nunca bloquea la publicación.
   */
  resolveItem?(delivery: WebhookDelivery, event: EngineEvent): Promise<IssueItem | null>
}
