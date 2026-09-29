import type { SlackMessageRef } from './permalink.js'

/**
 * La Web API de Slack con un bot token (`xoxb-…`), sin SDK. Scopes: `chat:write` para
 * publicar; `channels:history`/`groups:history` para leer; `users:read` para los nombres.
 * Todo lo que Slack contesta con `ok: false` tira con su `error`.
 */
export interface SlackClientOptions {
  /** El token, o de dónde pedirlo en cada llamada (ej. `process.env.SLACK_BOT_TOKEN`). */
  token: string | (() => string | undefined)
  /** Default: `https://slack.com/api`. */
  baseUrl?: string
  fetchImpl?: typeof fetch
}

export interface SlackMessage {
  ts: string
  text?: string
  user?: string
  bot_id?: string
  thread_ts?: string
  reply_count?: number
  subtype?: string
}

interface SlackResponse {
  ok: boolean
  error?: string
}

export class SlackClient {
  private readonly names = new Map<string, string>()

  constructor(private readonly options: SlackClientOptions) {}

  /** Si hay token: sin él, quien use el cliente puede apagarse en vez de fallar. */
  get enabled(): boolean {
    return Boolean(this.token())
  }

  /** Publica en un canal, o dentro de un hilo con `threadTs`. */
  async postMessage(input: {
    channel: string
    text: string
    threadTs?: string
  }): Promise<{ channel: string; ts: string }> {
    const { channel, ts } = await this.call<{ channel: string; ts: string }>(
      'chat.postMessage',
      {
        channel: input.channel,
        text: input.text,
        ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
      },
      'POST',
    )
    return { channel, ts }
  }

  /** El link público de un mensaje: lo que un humano abre, y lo que se guarda como "el hilo". */
  async permalink(channel: string, ts: string): Promise<string> {
    const { permalink } = await this.call<{ permalink: string }>('chat.getPermalink', {
      channel,
      message_ts: ts,
    })
    return permalink
  }

  /** El mensaje raíz del hilo y sus respuestas, en orden. */
  async replies(ref: Pick<SlackMessageRef, 'channel'> & { ts: string }, limit = 200) {
    const { messages } = await this.call<{ messages: SlackMessage[] }>('conversations.replies', {
      channel: ref.channel,
      ts: ref.ts,
      limit,
    })
    return messages
  }

  /** Los últimos mensajes de un canal, del más nuevo al más viejo. */
  async history(channel: string, limit = 50) {
    const { messages } = await this.call<{ messages: SlackMessage[] }>('conversations.history', {
      channel,
      limit,
    })
    return messages
  }

  /** El nombre visible de un usuario (cacheado). Si no se puede resolver, su id. */
  async userName(userId: string): Promise<string> {
    const cached = this.names.get(userId)
    if (cached) return cached
    try {
      const { user } = await this.call<{
        user: { name?: string; real_name?: string; profile?: { display_name?: string } }
      }>('users.info', { user: userId })
      const name = user.profile?.display_name || user.real_name || user.name || userId
      this.names.set(userId, name)
      return name
    } catch {
      return userId
    }
  }

  private token(): string | undefined {
    const { token } = this.options
    return typeof token === 'function' ? token() : token
  }

  private async call<T>(
    method: string,
    params: Record<string, unknown>,
    http: 'GET' | 'POST' = 'GET',
  ): Promise<T> {
    const token = this.token()
    if (!token) throw new Error('Slack: falta el bot token (SLACK_BOT_TOKEN)')
    const url = `${this.options.baseUrl ?? 'https://slack.com/api'}/${method}`
    const fetchImpl = this.options.fetchImpl ?? fetch
    const headers = { Authorization: `Bearer ${token}` }
    const response =
      http === 'GET'
        ? await fetchImpl(`${url}?${query(params)}`, { headers })
        : await fetchImpl(url, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' },
            body: JSON.stringify(params),
          })
    if (!response.ok) throw new Error(`Slack ${method}: HTTP ${response.status}`)
    const body = (await response.json()) as SlackResponse & T
    if (!body.ok) throw new Error(`Slack ${method}: ${body.error ?? 'error desconocido'}`)
    return body
  }
}

function query(params: Record<string, unknown>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) search.set(key, String(value))
  }
  return search.toString()
}
