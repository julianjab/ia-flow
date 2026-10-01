/** Un mensaje de Slack por su permalink: canal, `ts` del mensaje y, si es una respuesta, el del
 *  hilo. `https://x.slack.com/archives/C0ABC123/p1699999999123456?thread_ts=…` */
export interface SlackMessageRef {
  channel: string
  ts: string
  threadTs?: string
}

/** Tira si no es un permalink de Slack: un link roto tiene que decirlo, no adivinarse. */
export function parseSlackPermalink(url: string): SlackMessageRef {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`no es una URL: ${url}`)
  }
  if (!parsed.hostname.endsWith('.slack.com')) throw new Error(`no es de slack.com: ${url}`)
  const match = parsed.pathname.match(/^\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})\/?$/)
  if (!match) throw new Error(`no es un permalink de Slack: ${parsed.pathname}`)
  const [, channel, seconds, micros] = match as unknown as [string, string, string, string]
  const threadTs = parsed.searchParams.get('thread_ts') ?? undefined
  return { channel, ts: `${seconds}.${micros}`, ...(threadTs ? { threadTs } : {}) }
}

/** El `ts` del mensaje raíz del hilo de un permalink: el `thread_ts` si es una respuesta, si no
 *  el del propio mensaje. */
export function threadTsOf(url: string): string {
  const ref = parseSlackPermalink(url)
  return ref.threadTs ?? ref.ts
}
