// Parse Slack permalinks like:
//   https://workspace.slack.com/archives/C0ABC123/p1699999999123456
//   https://workspace.slack.com/archives/C0ABC123/p1699999999123456?thread_ts=1699999999.000000&cid=C0ABC123

export interface ParsedPermalink {
  channel: string
  ts: string
  thread_ts?: string
}

export function parseSlackPermalink(url: string): ParsedPermalink {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new Error(`Invalid URL: ${url}`)
  }

  if (!u.hostname.endsWith('.slack.com')) {
    throw new Error(`Not a slack.com URL: ${url}`)
  }

  const match = u.pathname.match(/^\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})\/?$/)
  if (!match) throw new Error(`Not a Slack permalink: ${u.pathname}`)

  const [, channel, seconds, micros] = match
  const ts = `${seconds}.${micros}`
  const thread_ts = u.searchParams.get('thread_ts') ?? undefined

  return { channel, ts, thread_ts }
}
