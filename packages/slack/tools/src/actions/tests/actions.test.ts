import { createEvent, EventBus, type PipelineExecutionContext } from '@ia-flow/agent-engine'
import { SlackClient } from '@ia-flow/slack-api'
import { describe, expect, it, vi } from 'vitest'
import { SlackChannelHistoryAction } from '../SlackChannelHistoryAction.js'
import { SlackPostMessageAction } from '../SlackPostMessageAction.js'
import { SlackReadThreadAction } from '../SlackReadThreadAction.js'

const ctx = (): PipelineExecutionContext => ({
  event: createEvent('e', {}),
  steps: {},
  bus: new EventBus(),
  pipelineId: 'p',
})

function fakeSlack(responses: Record<string, Record<string, unknown>>) {
  const calls: string[] = []
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(init?.body ? `${url} ${init.body}` : url)
    const method = Object.keys(responses).find((name) => url.includes(name)) ?? ''
    return new Response(JSON.stringify({ ok: true, ...responses[method] }))
  })
  return { client: new SlackClient({ token: 't', fetchImpl: fetchImpl as never }), calls }
}

const USERS = { 'users.info': { user: { profile: { display_name: 'juli' } } } }

describe('slack actions', () => {
  it('slack_read_thread reads the whole thread of any message link, with names', async () => {
    const { client, calls } = fakeSlack({
      ...USERS,
      'conversations.replies': {
        messages: [
          { ts: '1.0', user: 'U1', text: 'raíz' },
          { ts: '1.1', bot_id: 'B1', text: 'respuesta' },
        ],
      },
    })
    const text = await new SlackReadThreadAction(client).asTool(ctx()).handler({
      permalink: 'https://x.slack.com/archives/C1/p1699999999123456?thread_ts=1600000000.000001',
    })
    expect(text).toBe('[1.0] juli: raíz\n[1.1] bot:B1: respuesta')
    expect(calls[0]).toContain('ts=1600000000.000001')
  })

  it('slack_channel_history shows the channel oldest first', async () => {
    const { client } = fakeSlack({
      ...USERS,
      'conversations.history': {
        messages: [
          { ts: '2', user: 'U1', text: 'nuevo' },
          { ts: '1', user: 'U1', text: 'viejo' },
        ],
      },
    })
    expect(
      await new SlackChannelHistoryAction(client).asTool(ctx()).handler({ channel: 'C1' }),
    ).toBe('[1] juli: viejo\n[2] juli: nuevo')
  })

  it('slack_post_message writes (needs allowWrite), in a thread, and returns the link', async () => {
    const { client, calls } = fakeSlack({
      'chat.postMessage': { channel: 'C1', ts: '3.0' },
      'chat.getPermalink': { permalink: 'https://x.slack.com/archives/C1/p3' },
    })
    const action = new SlackPostMessageAction(client)
    expect(action.sideEffects).toBe('write')
    const link = await action.asTool(ctx()).handler({
      channel: 'C1',
      text: 'hola',
      thread: 'https://x.slack.com/archives/C1/p1699999999123456',
    })
    expect(link).toBe('https://x.slack.com/archives/C1/p3')
    expect(calls[0]).toContain('"thread_ts":"1699999999.123456"')
  })
})
