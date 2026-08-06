// Slack Web API client — thin wrapper around fetch, no extra deps.
// Auth: SLACK_BOT_TOKEN (xoxb-...) with scopes:
//   channels:history, groups:history, im:history, mpim:history,
//   channels:read, users:read, chat:write

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
  user: { id: string; name?: string; real_name?: string; profile?: { display_name?: string; real_name?: string } }
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
