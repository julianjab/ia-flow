import { createHmac, timingSafeEqual } from 'node:crypto'
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

// La forma del port `IWebhookTranslator` de `apps/server`, redeclarada acá.
// Un paquete no puede importar hacia adentro de la app que lo hospeda, y TS
// es estructural: `SlackWebhookTranslator` sigue entrando en la lista de
// traductores del server sin que ninguno de los dos conozca al otro.
export interface SlackWebhookDelivery {
  event: string
  payload: Record<string, unknown>
  deliveryId?: string
}

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
export class SlackWebhookTranslator {
  readonly source = 'slack'

  handles(event: string): boolean {
    return event === 'event_callback'
  }

  translate({ payload, deliveryId }: SlackWebhookDelivery): EngineEvent | null {
    return slackMessageEvent(payload, deliveryId)
  }
}

// ─── El borde HTTP ───────────────────────────────────────────────────────────
//
// La ruta vive en `apps/server` (es la app la que sabe de Hono), pero lo que
// hace falta para CREERLE a un delivery es conocimiento de Slack, y por eso
// viaja con el resto del paquete: quien monte el endpoint no tiene que volver
// a derivar el formato de la firma ni acordarse de la ventana de replay.

interface SlackEnvelope {
  type?: string
  challenge?: string
}

/** El handshake de la Events API. Slack lo manda al guardar la URL y espera el
 *  challenge de vuelta, en texto plano.
 *
 *  Se contesta ANTES de verificar la firma: en ese momento todavía no hay nada
 *  firmado que validar. */
export function urlVerification(payload: unknown): string | null {
  const env = payload as SlackEnvelope
  return env?.type === 'url_verification' && typeof env.challenge === 'string'
    ? env.challenge
    : null
}

/**
 * Verifica la firma `v0=` de Slack.
 *
 * Distinto del HMAC de GitHub en dos cosas que importan: la base incluye la
 * VERSIÓN y el TIMESTAMP (`v0:<ts>:<body>`), y hay que rechazar los
 * timestamps viejos — sin eso, un delivery capturado se puede reenviar para
 * siempre.
 */
export function verifySlackSignature(
  rawBody: string,
  timestamp: string | undefined,
  signature: string | undefined,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  if (!timestamp || !signature) return false
  const ts = Number(timestamp)
  if (!Number.isFinite(ts)) return false
  // Cinco minutos, el tope que Slack documenta.
  if (Math.abs(nowSeconds - ts) > 300) return false

  const expected = `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`
  const a = Buffer.from(expected)
  const b = Buffer.from(signature)
  // `timingSafeEqual` tira si los largos difieren, así que se comparan antes.
  // La comparación de tiempo constante importa: una normal filtra el prefijo
  // correcto byte a byte.
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
