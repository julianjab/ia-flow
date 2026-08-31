import {
  conversationsHistory,
  conversationsReplies,
  parseSlackPermalink,
  postMessage,
  slackDisabledReason,
} from '@ia-flow/slack'
import { Hono } from 'hono'
import { slack } from '../composition/container.js'
import { createLogger } from '../logger.js'

const log = createLogger('slack-route')

// El pasamanos HTTP sobre `@ia-flow/slack`. Lo que sabe de Slack lo sabe el
// paquete; acá sólo se valida la query y se traduce el error a un status.
export function createSlackRouter() {
  const app = new Hono()

  // Sin credencial nada de esto puede funcionar, y el error del cliente
  // (`SLACK_BOT_TOKEN is not set`) llegaría como un 500 que parece una falla
  // del server. Un 503 con el motivo es lo mismo que ya hace
  // `POST /api/webhooks/slack`, y es lo que la web muestra para explicar por
  // qué los pickers están vacíos.
  app.use('*', async (c, next) => {
    const reason = slackDisabledReason()
    if (reason) return c.json({ error: `Slack no está configurado: ${reason}` }, 503)
    await next()
  })

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

  // GET /api/slack/users?q=&limit= — directorio para el autocomplete de
  // reviewers. Incluye bots: taguear al bot revisor es medio caso de uso.
  app.get('/users', async (c) => {
    const limit = Math.min(Number.parseInt(c.req.query('limit') ?? '20', 10) || 20, 50)
    const members = await slack.directory.searchMembers(c.req.query('q') ?? '', limit)
    return c.json({ members })
  })

  // GET /api/slack/channels?q=&limit= — canales para el campo de canal.
  app.get('/channels', async (c) => {
    const limit = Math.min(Number.parseInt(c.req.query('limit') ?? '20', 10) || 20, 50)
    const { channels, warnings } = await slack.directory.searchChannels(
      c.req.query('q') ?? '',
      limit,
    )
    return c.json({ channels, ...(warnings.length ? { warnings } : {}) })
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
