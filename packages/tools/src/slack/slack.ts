import { registerTool } from '../engine.js'
import {
  type SlackMessage,
  conversationsHistory,
  conversationsReplies,
  getUserName,
  postMessage,
} from './client.js'
import { parseSlackPermalink } from './permalink.js'
// Slack tools — available to agents that list them in their tools[] config.
// Requires SLACK_BOT_TOKEN in env; the bot must be a member of any channel it reads.

async function formatMessages(messages: SlackMessage[]): Promise<string> {
  const rendered = await Promise.all(
    messages.map(async (m) => {
      const author = m.user ? await getUserName(m.user) : m.bot_id ? `bot:${m.bot_id}` : 'system'
      const iso = new Date(Number(m.ts.split('.')[0]) * 1000).toISOString()
      const text = (m.text ?? '').replace(/\n/g, '\n  ')
      const thread = m.thread_ts && m.thread_ts !== m.ts ? ` (in-thread of ${m.thread_ts})` : ''
      const replies = m.reply_count ? ` [${m.reply_count} replies]` : ''
      return `[${iso}] ${author} (ts=${m.ts})${thread}${replies}\n  ${text}`
    }),
  )
  return rendered.join('\n\n')
}

// ─── slack_resolve_permalink ─────────────────────────────────────────────────

registerTool({
  name: 'slack_resolve_permalink',
  description:
    'Read a Slack message (and its thread, if any) from a permalink URL. Returns the message plus all replies when the link points to a thread.',
  input_schema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'Slack permalink, e.g. https://workspace.slack.com/archives/C.../p...',
      },
    },
    required: ['url'],
  },
  async execute(input: any): Promise<string> {
    const { channel, ts, thread_ts } = parseSlackPermalink(input.url)
    const parentTs = thread_ts ?? ts

    // If it's threaded (or has replies), fetch the full thread; otherwise just that message.
    if (thread_ts) {
      const res = await conversationsReplies({ channel, ts: parentTs, limit: 200 })
      return `channel=${channel} thread_ts=${parentTs}\n\n` + (await formatMessages(res.messages))
    }

    const single = await conversationsHistory({ channel, latest: ts, inclusive: true, limit: 1 })
    const msg = single.messages[0]
    if (!msg) return `No message found at ts=${ts} in channel=${channel}`
    if (msg.reply_count && msg.reply_count > 0) {
      const thread = await conversationsReplies({ channel, ts, limit: 200 })
      return `channel=${channel} thread_ts=${ts}\n\n` + (await formatMessages(thread.messages))
    }
    return `channel=${channel}\n\n` + (await formatMessages([msg]))
  },
})

// ─── slack_read_thread ───────────────────────────────────────────────────────

registerTool({
  name: 'slack_read_thread',
  description: 'Read all replies of a Slack thread given the channel ID and the parent message ts.',
  input_schema: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'Channel ID, e.g. C0ABC123' },
      thread_ts: {
        type: 'string',
        description: 'ts of the thread parent message, e.g. 1699999999.123456',
      },
      limit: { type: 'number', description: 'Max messages to return (default 200)' },
    },
    required: ['channel', 'thread_ts'],
  },
  async execute(input: any): Promise<string> {
    const res = await conversationsReplies({
      channel: input.channel,
      ts: input.thread_ts,
      limit: input.limit ?? 200,
    })
    return await formatMessages(res.messages)
  },
})

// ─── slack_channel_history ───────────────────────────────────────────────────

registerTool({
  name: 'slack_channel_history',
  description:
    'Read recent messages from a Slack channel by ID. The bot must be a member of the channel.',
  input_schema: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'Channel ID, e.g. C0ABC123' },
      limit: { type: 'number', description: 'Max messages (default 50, max 200)' },
      oldest: { type: 'string', description: 'Only messages after this ts (optional)' },
      latest: { type: 'string', description: 'Only messages before this ts (optional)' },
    },
    required: ['channel'],
  },
  async execute(input: any): Promise<string> {
    const res = await conversationsHistory({
      channel: input.channel,
      limit: Math.min(input.limit ?? 50, 200),
      oldest: input.oldest,
      latest: input.latest,
    })
    if (!res.messages.length) return '(no messages)'
    return await formatMessages(res.messages)
  },
})

// ─── slack_post_message ──────────────────────────────────────────────────────

registerTool({
  name: 'slack_post_message',
  description:
    'Post a message to a Slack channel or thread. Requires chat:write scope and the bot in the channel.',
  input_schema: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'Channel ID (C...), DM ID (D...), or #channel-name' },
      text: { type: 'string', description: 'Message text (mrkdwn supported)' },
      thread_ts: { type: 'string', description: 'Optional: parent ts to reply within a thread' },
    },
    required: ['channel', 'text'],
  },
  async execute(input: any): Promise<string> {
    const res = await postMessage({
      channel: input.channel,
      text: input.text,
      thread_ts: input.thread_ts,
    })
    return JSON.stringify({ channel: res.channel, ts: res.ts })
  },
})
