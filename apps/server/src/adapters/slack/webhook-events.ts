// Slack Events API → EngineEvent.
//
// El caso que reencuadra el `scope`. Un evento de GitHub trae su proyecto
// puesto; un mensaje de Slack no: alguien escribe "el login anda mal en
// staging" y ahí no hay proyecto, ni repo, ni tipo.
//
// La consecuencia de diseño es que **`scope` no es metadata: es lo que hace
// ruteable a un evento**. Uno sin `projectId` no está incompleto — está *sin
// rutear todavía*, y sólo lo ven las reglas globales (fail-closed en
// `matchScope`). Asignarle scope es una función DENTRO del modelo: un agente
// de triage que lee el mensaje y emite un evento ya scopeado.
//
// Este módulo es puro: recibe el payload y devuelve el evento. La firma y el
// challenge se verifican en la ruta, que es donde vive el borde HTTP.
import type { EngineEvent } from '@ia-flow/shared'
import { createEvent } from '@ia-flow/shared'
import type { IWebhookTranslator, WebhookDelivery } from '../../domain/ports/IWebhookTranslator.js'

/** Un mensaje en un canal o hilo. Es el único tipo que produce evento hoy: el
 *  resto de la Events API (reacciones, joins) no tiene consumidor. */
export const SLACK_MESSAGE = 'slack.message'

interface SlackEnvelope {
  type?: string
  challenge?: string
  event_id?: string
  event?: {
    type?: string
    subtype?: string
    channel?: string
    user?: string
    bot_id?: string
    text?: string
    ts?: string
    thread_ts?: string
  }
}

/**
 * `event_callback` con un mensaje → `slack.message`, o `null`.
 *
 * Se descarta más de lo que se acepta, y cada descarte tiene su motivo:
 *
 * - **Mensajes de bots** (incluido el propio). Sin esto, un agente que comenta
 *   en el hilo produce un evento que lo despierta a él mismo — el loop más
 *   fácil de escribir sin darse cuenta.
 * - **Subtipos** (`message_changed`, `message_deleted`, joins). Editar un
 *   mensaje no es un pedido nuevo.
 * - **Mensajes sin texto**: un adjunto solo no tiene nada que un agente pueda
 *   leer.
 */
export function slackMessageEvent(payload: unknown, deliveryId?: string): EngineEvent | null {
  const env = payload as SlackEnvelope
  if (env?.type !== 'event_callback') return null

  const ev = env.event
  if (!ev || ev.type !== 'message') return null
  if (ev.subtype) return null
  if (ev.bot_id) return null
  const text = (ev.text ?? '').trim()
  if (!text) return null

  return createEvent({
    // `event_id` es la identidad del delivery para Slack, igual que el
    // `X-Slack-Retry-Num` que lo acompaña: Slack reintenta, y sin esto un
    // reintento dispararía las reglas dos veces.
    ...((deliveryId ?? env.event_id)
      ? { id: `${deliveryId ?? env.event_id}:${SLACK_MESSAGE}` }
      : {}),
    type: SLACK_MESSAGE,
    source: 'slack',
    // SIN scope a propósito. Nadie sabe todavía de qué proyecto habla este
    // mensaje — averiguarlo es el trabajo de la regla de triage.
    scope: {},
    payload: {
      text,
      channel: ev.channel,
      author: ev.user,
      ts: ev.ts,
      // Presente sólo si es respuesta en un hilo. Es lo que permite atar un
      // mensaje al hilo de review de una task (ver `getSlackThreadUrl`).
      threadTs: ev.thread_ts,
      isThreadReply: Boolean(ev.thread_ts && ev.thread_ts !== ev.ts),
    },
  })
}

/**
 * El traductor de Slack, como port.
 *
 * Sin dependencias: a diferencia del de GitHub no resuelve scope, porque un
 * mensaje de Slack no lo tiene todavía (ver el encabezado de este archivo).
 * `event_callback` es el único sobre que trae hechos; `url_verification` lo
 * atiende la ruta antes de llegar acá, porque se responde sin firma.
 */
export class SlackWebhookTranslator implements IWebhookTranslator {
  readonly source = 'slack'

  handles(event: string): boolean {
    return event === 'event_callback'
  }

  translate({ payload, deliveryId }: WebhookDelivery): EngineEvent | null {
    return slackMessageEvent(payload, deliveryId)
  }
}
