/**
 * De un payload crudo de la Events API de Slack a lo que el runner necesita — puro, sin I/O.
 * Sólo pasan los mensajes de PERSONAS: los de un bot, los editados o borrados (`subtype`) y los
 * del propio bot se descartan acá, para que lo que el agente publique nunca lo despierte de nuevo.
 */

/** Un mensaje humano que le importa al runner: una mención al bot o un mensaje (de hilo o no). */
export interface SlackSocketEvent {
  /** `app_mention`: le escribieron al bot. `message`: cualquier mensaje de un canal donde está. */
  kind: 'app_mention' | 'message'
  /** Id del evento (`Ev…`): lo repite Slack si reintenta la entrega. */
  eventId: string
  channel: string
  /** El id de Slack de quien escribió (`U…`). */
  user: string
  text: string
  /** `ts` del mensaje. */
  ts: string
  /** `ts` del mensaje raíz del hilo; ausente si el mensaje no es de un hilo. */
  threadTs?: string
  /** Es una respuesta dentro de un hilo (no el mensaje raíz). */
  isThreadReply: boolean
  /** Los ids de Slack mencionados en el texto (`<@U…>`), sin repetir. */
  mentions: string[]
}

interface RawSlackEvent {
  type?: unknown
  subtype?: unknown
  bot_id?: unknown
  user?: unknown
  text?: unknown
  channel?: unknown
  ts?: unknown
  thread_ts?: unknown
}

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined

/** Los ids mencionados en un texto de Slack (`<@U123>` o `<@U123|nombre>`), sin repetir. */
export function parseMentions(text: string): string[] {
  const ids = [...text.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)].map((m) => m[1] as string)
  return [...new Set(ids)]
}

/** El texto sin las menciones a `userId` (el bot), listo para leerse como el pedido. */
export function stripMention(text: string, userId: string): string {
  return text
    .replace(new RegExp(`<@${userId}(?:\\|[^>]*)?>`, 'g'), '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * El payload de un envelope `events_api` como `SlackSocketEvent`, o `undefined` si no es un
 * mensaje humano que valga la pena: otro tipo de evento, un bot, un `subtype` (edición, borrado,
 * join…), el propio bot (`botUserId`) o uno sin texto, canal o autor.
 */
export function parseSlackEvent(
  payload: unknown,
  options: { botUserId?: string } = {},
): SlackSocketEvent | undefined {
  const body = payload as { event_id?: unknown; event?: RawSlackEvent } | null
  const event = body?.event
  if (!event) return undefined
  if (event.type !== 'app_mention' && event.type !== 'message') return undefined
  if (event.subtype !== undefined || event.bot_id !== undefined) return undefined
  const user = str(event.user)
  const channel = str(event.channel)
  const ts = str(event.ts)
  const text = typeof event.text === 'string' ? event.text : undefined
  const eventId = str(body?.event_id)
  if (!user || !channel || !ts || !text || !eventId) return undefined
  if (user === options.botUserId) return undefined
  const threadTs = str(event.thread_ts)
  return {
    kind: event.type,
    eventId,
    channel,
    user,
    text,
    ts,
    ...(threadTs ? { threadTs } : {}),
    isThreadReply: threadTs !== undefined && threadTs !== ts,
    mentions: parseMentions(text),
  }
}
