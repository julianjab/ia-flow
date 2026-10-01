import { describe, expect, it, vi } from 'vitest'
import { parseSlackPermalink, threadTsOf } from '../permalink.js'
import { SlackClient } from '../SlackClient.js'

const answer = (body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

describe('parseSlackPermalink', () => {
  it('reads channel and ts, and the thread of a reply', () => {
    expect(parseSlackPermalink('https://x.slack.com/archives/C0ABC/p1699999999123456')).toEqual({
      channel: 'C0ABC',
      ts: '1699999999.123456',
    })
    const reply = 'https://x.slack.com/archives/C0ABC/p1699999999123456?thread_ts=1600000000.000001'
    expect(threadTsOf(reply)).toBe('1600000000.000001')
    expect(threadTsOf('https://x.slack.com/archives/C0ABC/p1699999999123456')).toBe(
      '1699999999.123456',
    )
  })

  it('rejects what is not a Slack permalink', () => {
    expect(() => parseSlackPermalink('no')).toThrow(/no es una URL/)
    expect(() => parseSlackPermalink('https://github.com/x')).toThrow(/slack.com/)
    expect(() => parseSlackPermalink('https://x.slack.com/foo')).toThrow(/permalink/)
  })
})

describe('SlackClient', () => {
  it('posts with the bot token, in a thread when asked', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      answer({ ok: true, channel: 'C1', ts: '1.2' }),
    )
    const client = new SlackClient({ token: 'xoxb', fetchImpl: fetchImpl as never })

    expect(await client.postMessage({ channel: 'C1', text: 'hola', threadTs: '1.0' })).toEqual({
      channel: 'C1',
      ts: '1.2',
    })
    const [url, init] = fetchImpl.mock.calls[0] ?? []
    expect(url).toBe('https://slack.com/api/chat.postMessage')
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer xoxb' })
    expect(JSON.parse(String(init?.body))).toEqual({
      channel: 'C1',
      text: 'hola',
      thread_ts: '1.0',
    })
  })

  it('reads with GET query params and caches user names', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes('users.info')
        ? answer({ ok: true, user: { profile: { display_name: 'juli' } } })
        : answer({ ok: true, messages: [{ ts: '1', text: 'x' }] }),
    )
    const client = new SlackClient({ token: 'xoxb', fetchImpl: fetchImpl as never })

    expect(await client.replies({ channel: 'C1', ts: '1' })).toEqual([{ ts: '1', text: 'x' }])
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://slack.com/api/conversations.replies?channel=C1&ts=1&limit=200',
    )
    expect(await client.userName('U1')).toBe('juli')
    expect(await client.userName('U1')).toBe('juli')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('throws with the Slack error, and without a token says so', async () => {
    const failing = new SlackClient({
      token: 'xoxb',
      fetchImpl: (async () => answer({ ok: false, error: 'channel_not_found' })) as never,
    })
    await expect(failing.history('C1')).rejects.toThrow('channel_not_found')
    const off = new SlackClient({ token: () => undefined })
    expect(off.enabled).toBe(false)
    await expect(off.history('C1')).rejects.toThrow(/SLACK_BOT_TOKEN/)
  })
})

describe('SlackClient.botUserId', () => {
  it('asks auth.test once and remembers the bot id', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      answer({ ok: true, user_id: 'UBOT' }),
    )
    const slack = new SlackClient({ token: 'xoxb', fetchImpl: fetchImpl as never })
    expect(await slack.botUserId()).toBe('UBOT')
    expect(await slack.botUserId()).toBe('UBOT')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain('auth.test')
  })
})
