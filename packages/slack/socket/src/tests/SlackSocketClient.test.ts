import { describe, expect, it, vi } from 'vitest'
import type { SlackSocketEvent } from '../events.js'
import { SlackSocketClient, type SocketLike } from '../SlackSocketClient.js'

class FakeSocket implements SocketLike {
  static all: FakeSocket[] = []
  sent: unknown[] = []
  closed = false
  onopen: SocketLike['onopen'] = null
  onmessage: SocketLike['onmessage'] = null
  onclose: SocketLike['onclose'] = null
  onerror: SocketLike['onerror'] = null
  constructor(readonly url: string) {
    FakeSocket.all.push(this)
  }
  send(data: string) {
    this.sent.push(JSON.parse(data))
  }
  close() {
    if (this.closed) return
    this.closed = true
    this.onclose?.({})
  }
  /** Lo que Slack manda por la conexión. */
  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) })
  }
}

const eventsApi = (event: Record<string, unknown>, eventId = 'Ev1', envelope = 'env-1') => ({
  type: 'events_api',
  envelope_id: envelope,
  payload: {
    event_id: eventId,
    event: { type: 'app_mention', user: 'U1', channel: 'C1', ts: '1.1', text: 'hola', ...event },
  },
})

function setup(
  opts: {
    openResults?: Array<{ ok: boolean; url?: string; error?: string }>
    onEvent?: (event: SlackSocketEvent) => void | Promise<void>
    token?: string | undefined
    botUserId?: string
  } = {},
) {
  FakeSocket.all = []
  const events: SlackSocketEvent[] = []
  const logs: string[] = []
  const delays: number[] = []
  const results = [...(opts.openResults ?? [])]
  const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => {
    const next = results.shift() ?? { ok: true, url: 'wss://slack.test/ws' }
    return new Response(JSON.stringify(next))
  })
  const client = new SlackSocketClient({
    appToken: 'token' in opts ? (opts.token as string) : 'xapp-1',
    onEvent: opts.onEvent ?? ((event) => void events.push(event)),
    ...(opts.botUserId ? { botUserId: opts.botUserId } : {}),
    log: (line) => logs.push(line),
    fetchImpl: fetchImpl as unknown as typeof fetch,
    webSocketImpl: FakeSocket,
    delay: async (ms) => void delays.push(ms),
  })
  /** Abre la conexión y contesta el `hello`. */
  const start = async () => {
    const before = FakeSocket.all.length
    const started = client.start()
    await vi.waitFor(() => expect(FakeSocket.all.length).toBeGreaterThan(before))
    FakeSocket.all.at(-1)?.receive({ type: 'hello' })
    await started
  }
  return { client, events, logs, delays, fetchImpl, start }
}

describe('SlackSocketClient', () => {
  it('opens the connection with the app token and resolves on hello', async () => {
    const { start, fetchImpl } = setup()
    await start()
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://slack.com/api/apps.connections.open')
    expect(init.headers).toEqual({ authorization: 'Bearer xapp-1' })
    expect(FakeSocket.all[0]?.url).toBe('wss://slack.test/ws')
  })

  it('fails to start without a token or when Slack refuses the connection', async () => {
    const noToken = setup({ token: undefined })
    expect(noToken.client.enabled).toBe(false)
    await expect(noToken.client.start()).rejects.toThrow(/SLACK_APP_TOKEN/)

    const refused = setup({ openResults: [{ ok: false, error: 'invalid_auth' }] })
    await expect(refused.client.start()).rejects.toThrow(/invalid_auth/)
    expect(FakeSocket.all).toEqual([])
  })

  it('acks the envelope and delivers a human message once', async () => {
    const { start, events } = setup({ botUserId: 'UBOT' })
    await start()
    const socket = FakeSocket.all[0] as FakeSocket
    socket.receive(eventsApi({ text: '<@UBOT> crea un issue' }))
    expect(socket.sent).toEqual([{ envelope_id: 'env-1' }])
    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(events[0]).toMatchObject({ channel: 'C1', user: 'U1', mentions: ['UBOT'] })
  })

  it('acks but does not deliver bots, edits or its own messages', async () => {
    const { start, events } = setup({ botUserId: 'UBOT' })
    await start()
    const socket = FakeSocket.all[0] as FakeSocket
    socket.receive(eventsApi({ bot_id: 'B1' }, 'E1', 'a'))
    socket.receive(eventsApi({ subtype: 'message_changed' }, 'E2', 'b'))
    socket.receive(eventsApi({ user: 'UBOT' }, 'E3', 'c'))
    socket.receive({ type: 'slash_commands', envelope_id: 'd', payload: {} })
    expect(socket.sent).toEqual([
      { envelope_id: 'a' },
      { envelope_id: 'b' },
      { envelope_id: 'c' },
      { envelope_id: 'd' },
    ])
    await Promise.resolve()
    expect(events).toEqual([])
  })

  it('delivers the same mention once, whether it comes as app_mention and message or as a retry', async () => {
    const { start, events } = setup()
    await start()
    const socket = FakeSocket.all[0] as FakeSocket
    socket.receive(eventsApi({ type: 'app_mention' }, 'Ev1', 'a'))
    socket.receive(eventsApi({ type: 'message' }, 'Ev2', 'b'))
    socket.receive(eventsApi({ type: 'app_mention' }, 'Ev1', 'c'))
    socket.receive(eventsApi({ ts: '2.2' }, 'Ev3', 'd'))
    await vi.waitFor(() => expect(events).toHaveLength(2))
    expect(events.map((e) => e.ts)).toEqual(['1.1', '2.2'])
  })

  it('logs a failing onEvent and keeps delivering', async () => {
    const seen: string[] = []
    const { start, logs } = setup({
      onEvent: (event) => {
        seen.push(event.ts)
        if (event.ts === '1.1') throw new Error('boom')
      },
    })
    await start()
    const socket = FakeSocket.all[0] as FakeSocket
    socket.receive(eventsApi({}, 'E1', 'a'))
    socket.receive(eventsApi({ ts: '2.2' }, 'E2', 'b'))
    await vi.waitFor(() => expect(seen).toEqual(['1.1', '2.2']))
    expect(logs.some((line) => line.includes('onEvent falló') && line.includes('boom'))).toBe(true)
  })

  it('ignores a message that is not JSON', async () => {
    const { start, logs, events } = setup()
    await start()
    const socket = FakeSocket.all[0] as FakeSocket
    socket.onmessage?.({ data: 'no-json' })
    expect(logs.some((line) => line.includes('no es JSON'))).toBe(true)
    expect(events).toEqual([])
  })

  it('reconnects when Slack asks to (disconnect) and resets the backoff on hello', async () => {
    const { start, delays } = setup()
    await start()
    FakeSocket.all[0]?.receive({ type: 'disconnect', reason: 'refresh_requested' })
    await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(2))
    FakeSocket.all[1]?.receive({ type: 'hello' })
    expect(delays).toEqual([1_000])
  })

  it('reconnects with growing waits when the connection cannot be reopened', async () => {
    const { start, delays } = setup({
      openResults: [
        { ok: true, url: 'wss://a' },
        { ok: false, error: 'ratelimited' },
        { ok: false, error: 'ratelimited' },
      ],
    })
    await start()
    FakeSocket.all[0]?.close()
    await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(2))
    expect(delays).toEqual([1_000, 2_000, 4_000])
  })

  it('does not reconnect after stop()', async () => {
    const { client, start, delays } = setup()
    await start()
    client.stop()
    await Promise.resolve()
    expect(FakeSocket.all[0]?.closed).toBe(true)
    expect(FakeSocket.all).toHaveLength(1)
    expect(delays).toEqual([])
  })

  it('can start again after stop()', async () => {
    const { client, start } = setup()
    await start()
    client.stop()
    await start()
    expect(FakeSocket.all).toHaveLength(2)
  })
})
