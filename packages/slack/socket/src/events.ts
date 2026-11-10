/**
 * De un payload crudo de la Events API de Slack a lo que el runner necesita — puro, sin I/O.
 * Pasan los mensajes de PERSONAS y, de otros bots, sólo las RESPUESTAS dentro de un hilo: los
 * reviewers son agentes (bots de Slack) y contestan en el hilo del pedido de review. El resto de lo
 * que publica un bot (mensajes sueltos, raíces de hilo), lo editado o borrado (`subtype`) y lo del
 * propio bot se descarta acá, para que lo que el agente publique nunca lo despierte de nuevo.
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
  /** Lo publicó otro bot (un agente reviewer), no una persona. Sólo pasa si es respuesta de hilo. */
  fromBot: boolean
}

interface RawSlackEvent {
  type?: unknown
  subtype?: unknown
  bot_id?: unknown
  bot_profile?: unknown
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
 * Quién escribió, o `undefined` si el `subtype` lo descarta (edición, borrado, join…). Un bot que
 * publica con su token trae `bot_id` y su usuario en `user`; uno viejo (webhook, `subtype:
 * bot_message`) sólo `bot_id`: ahí el autor es el `bot_id`.
 */
function authorOf(event: RawSlackEvent): { user: string; fromBot: boolean } | undefined {
  const botId = str(event.bot_id)
  const fromBot = botId !== undefined
  if (event.subtype !== undefined && !(fromBot && event.subtype === 'bot_message')) return undefined
  const user = str(event.user) ?? botId
  return user ? { user, fromBot } : undefined
}

/**
 * El payload de un envelope `events_api` como `SlackSocketEvent`, o `undefined` si no vale la
 * pena: otro tipo de evento, un `subtype` descartado (`authorOf`), un bot que no contesta en un
 * hilo, el propio bot (`botUserId`) o uno sin texto, canal o autor.
 */
export function parseSlackEvent(
  payload: unknown,
  options: { botUserId?: string } = {},
): SlackSocketEvent | undefined {
  const body = payload as { event_id?: unknown; event?: RawSlackEvent } | null
  const event = body?.event
  if (!event) return undefined
  if (event.type !== 'app_mention' && event.type !== 'message') return undefined
  const author = authorOf(event)
  const channel = str(event.channel)
  const ts = str(event.ts)
  const text = typeof event.text === 'string' ? event.text : undefined
  const eventId = str(body?.event_id)
  if (!author || !channel || !ts || !text || !eventId) return undefined
  if (author.user === options.botUserId) return undefined
  const threadTs = str(event.thread_ts)
  const isThreadReply = threadTs !== undefined && threadTs !== ts
  if (author.fromBot && (!isThreadReply || event.type !== 'message')) return undefined
  return {
    kind: event.type,
    eventId,
    channel,
    user: author.user,
    text,
    ts,
    ...(threadTs ? { threadTs } : {}),
    isThreadReply,
    mentions: parseMentions(text),
    fromBot: author.fromBot,
  }
}
