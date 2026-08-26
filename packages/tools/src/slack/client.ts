// Slack Web API client — thin wrapper around fetch, no extra deps.
// Auth: SLACK_BOT_TOKEN (xoxb-...) with scopes:
//   channels:history, groups:history, im:history, mpim:history,
//   channels:read, users:read, chat:write
// `users:read` is what the reviewer autocomplete needs (users.list); without
// it everything else still works, only the picker comes back empty.

const SLACK_API = 'https://slack.com/api'

interface SlackResponse {
  ok: boolean
  error?: string
  [k: string]: unknown
}

function requireToken(): string {
  const token = Bun.env.SLACK_BOT_TOKEN
  if (!token) throw new Error('SLACK_BOT_TOKEN is not set')
  return token
}

async function call<T extends SlackResponse>(
  method: string,
  params: Record<string, unknown>,
  httpMethod: 'GET' | 'POST' = 'GET',
): Promise<T> {
  const token = requireToken()
  const url = `${SLACK_API}/${method}`

  let res: Response
  if (httpMethod === 'GET') {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) qs.set(k, String(v))
    }
    res = await fetch(`${url}?${qs}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  } else {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(params),
    })
  }

  if (!res.ok) throw new Error(`Slack HTTP ${res.status}: ${await res.text()}`)
  const json = (await res.json()) as T
  if (!json.ok) throw new Error(`Slack API error: ${json.error ?? 'unknown'}`)
  return json
}

export interface SlackMessage {
  type?: string
  user?: string
  bot_id?: string
  text?: string
  ts: string
  thread_ts?: string
  reply_count?: number
  subtype?: string
  [k: string]: unknown
}

export interface HistoryResponse extends SlackResponse {
  messages: SlackMessage[]
  has_more?: boolean
  response_metadata?: { next_cursor?: string }
}

export function conversationsHistory(params: {
  channel: string
  latest?: string
  oldest?: string
  inclusive?: boolean
  limit?: number
  cursor?: string
}): Promise<HistoryResponse> {
  return call<HistoryResponse>('conversations.history', params, 'GET')
}

export function conversationsReplies(params: {
  channel: string
  ts: string
  limit?: number
  cursor?: string
}): Promise<HistoryResponse> {
  return call<HistoryResponse>('conversations.replies', params, 'GET')
}

export interface UserInfoResponse extends SlackResponse {
  user: {
    id: string
    name?: string
    real_name?: string
    profile?: { display_name?: string; real_name?: string }
  }
}

const userCache = new Map<string, string>()

export async function getUserName(userId: string): Promise<string> {
  if (!userId) return 'unknown'
  const cached = userCache.get(userId)
  if (cached) return cached
  try {
    const res = await call<UserInfoResponse>('users.info', { user: userId }, 'GET')
    const name =
      res.user.profile?.display_name ||
      res.user.profile?.real_name ||
      res.user.real_name ||
      res.user.name ||
      userId
    userCache.set(userId, name)
    return name
  } catch {
    return userId
  }
}

export interface PostMessageResponse extends SlackResponse {
  channel: string
  ts: string
}

export function postMessage(params: {
  channel: string
  text: string
  thread_ts?: string
  reply_broadcast?: boolean
}): Promise<PostMessageResponse> {
  return call<PostMessageResponse>('chat.postMessage', params, 'POST')
}

export interface ConversationsListResponse extends SlackResponse {
  channels: Array<{ id: string; name: string; is_private?: boolean; is_archived?: boolean }>
  response_metadata?: { next_cursor?: string }
}

export function conversationsList(params: {
  types?: string
  limit?: number
  cursor?: string
  exclude_archived?: boolean
}): Promise<ConversationsListResponse> {
  return call<ConversationsListResponse>('conversations.list', params, 'GET')
}

export interface SlackUser {
  id: string
  name?: string
  real_name?: string
  deleted?: boolean
  is_bot?: boolean
  profile?: { display_name?: string; real_name?: string }
}

export interface UsersListResponse extends SlackResponse {
  members: SlackUser[]
  response_metadata?: { next_cursor?: string }
}

/**
 * Directorio del workspace. Slack **no** tiene búsqueda server-side de
 * usuarios: para autocompletar hay que listar y filtrar del lado nuestro, que
 * es lo que hace SlackDirectory en el server. Requiere el scope `users:read`.
 */
export function usersList(params: {
  limit?: number
  cursor?: string
}): Promise<UsersListResponse> {
  return call<UsersListResponse>('users.list', params, 'GET')
}

export interface PermalinkResponse extends SlackResponse {
  channel: string
  permalink: string
}

/** URL pública de un mensaje. Es lo que se guarda como "link del hilo": un
 *  `channel`+`ts` no le sirve a un humano ni sobrevive fuera de la API. */
export function chatGetPermalink(params: {
  channel: string
  message_ts: string
}): Promise<PermalinkResponse> {
  return call<PermalinkResponse>('chat.getPermalink', params, 'GET')
}
