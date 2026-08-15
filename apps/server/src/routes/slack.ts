import {
  conversationsHistory,
  conversationsReplies,
  parseSlackPermalink,
  postMessage,
} from '@ia-flow/tools'
import { Hono } from 'hono'
import { createLogger } from '../logger.js'

const log = createLogger('slack-route')

export function createSlackRouter() {
  const app = new Hono()

  // POST /api/slack/resolve  { url }
  app.post('/resolve', async (c) => {
    let body: { url?: string }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }
    if (!body.url) return c.json({ error: 'url is required' }, 400)

    try {
      const parsed = parseSlackPermalink(body.url)
      const parentTs = parsed.thread_ts ?? parsed.ts
      if (parsed.thread_ts) {
        const res = await conversationsReplies({
          channel: parsed.channel,
          ts: parentTs,
          limit: 200,
        })
        return c.json({ ...parsed, messages: res.messages })
      }
      const res = await conversationsHistory({
        channel: parsed.channel,
        latest: parsed.ts,
        inclusive: true,
        limit: 1,
      })
      const msg = res.messages[0]
      if (msg?.reply_count && msg.reply_count > 0) {
        const thread = await conversationsReplies({
          channel: parsed.channel,
          ts: parsed.ts,
          limit: 200,
        })
        return c.json({ ...parsed, thread_ts: parsed.ts, messages: thread.messages })
      }
      return c.json({ ...parsed, messages: res.messages })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.warn({ err: msg }, 'resolve failed')
      return c.json({ error: msg }, 400)
    }
  })

  // GET /api/slack/history?channel=C123&limit=50
  app.get('/history', async (c) => {
    const channel = c.req.query('channel')
    if (!channel) return c.json({ error: 'channel is required' }, 400)
    const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10), 200)
    try {
      const res = await conversationsHistory({ channel, limit })
      return c.json({ channel, messages: res.messages, has_more: res.has_more })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ error: msg }, 500)
    }
  })

  // GET /api/slack/thread?channel=C123&thread_ts=1699999999.123456
  app.get('/thread', async (c) => {
    const channel = c.req.query('channel')
    const thread_ts = c.req.query('thread_ts')
    if (!channel || !thread_ts) return c.json({ error: 'channel and thread_ts are required' }, 400)
    try {
      const res = await conversationsReplies({ channel, ts: thread_ts, limit: 200 })
      return c.json({ channel, thread_ts, messages: res.messages })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ error: msg }, 500)
    }
  })

  // POST /api/slack/post  { channel, text, thread_ts? }
  app.post('/post', async (c) => {
    let body: { channel?: string; text?: string; thread_ts?: string }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }
    if (!body.channel || !body.text) return c.json({ error: 'channel and text are required' }, 400)
    try {
      const res = await postMessage({
        channel: body.channel,
        text: body.text,
        thread_ts: body.thread_ts,
      })
      return c.json({ channel: res.channel, ts: res.ts })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ error: msg }, 500)
    }
  })

  return app
}
