import { describe, expect, it } from 'bun:test'
import type { DomainEvent } from '@ia-flow/agent-engine'
import type { SlackSocketEvent } from '@ia-flow/slack-socket'
import { listenedTypes } from '../listening.js'
import { slackMessageEvent, slackScope, startSlackIngress } from '../slackIngress.js'

/** Reintenta `check` hasta que no tire (o vence): lo que `vi.waitFor` hace en vitest. */
async function waitFor(check: () => unknown, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      check()
      return
    } catch (error) {
      if (Date.now() > deadline) throw error
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
}

const human = (extra: Partial<SlackSocketEvent> = {}): SlackSocketEvent => ({
  kind: 'app_mention',
  eventId: 'Ev1',
  channel: 'C1',
  user: 'U1',
  text: '<@UBOT> crea un issue',
  ts: '10.1',
  isThreadReply: false,
  mentions: ['UBOT'],
  ...extra,
})

describe('slackMessageEvent', () => {
  it('carries the catalog fields and whether the bot was mentioned', () => {
    const event = slackMessageEvent(human(), 'UBOT')
    expect(event.type).toBe('slack.message')
    expect(event.payload).toMatchObject({
      text: '<@UBOT> crea un issue',
      channel: 'C1',
      author: 'U1',
      ts: '10.1',
      isThreadReply: false,
      mentionsBot: true,
    })
    expect(event.payload.threadTs).toBeUndefined()
    expect(event.scope).toEqual({ source: 'slack', channel: 'C1' })
  })

  it('scopes a thread reply by its thread, and does not claim a mention it cannot check', () => {
    const reply = human({ kind: 'message', threadTs: '9.0', isThreadReply: true })
    expect(slackScope(reply)).toEqual({ source: 'slack', channel: 'C1', thread: 'C1:9.0' })
    expect(slackMessageEvent(reply, undefined).payload).toMatchObject({
      threadTs: '9.0',
      isThreadReply: true,
      mentionsBot: false,
    })
  })
})

describe('listenedTypes', () => {
  it('lists the raw GitHub and Slack types some pipeline listens to', () => {
    const mounted = {
      pipelines: () =>
        [{ on: ['github.issue_comment', 'slack.message'] }, { on: ['issue.created'] }] as never,
    }
    expect([...listenedTypes(mounted)].sort()).toEqual(['github.issue_comment', 'slack.message'])
    expect([...listenedTypes(mounted, ['slack.'])]).toEqual(['slack.message'])
  })
})

class FakeSocket {
  static all: FakeSocket[] = []
  sent: unknown[] = []
  closed = false
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
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
  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) })
  }
}

const envelope = (text = 'hola', ts = '1.1', envelopeId = 'e1') => ({
  type: 'events_api',
  envelope_id: envelopeId,
  payload: {
    event_id: `Ev-${ts}`,
    event: { type: 'message', user: 'U1', channel: 'C1', ts, text },
  },
})

function ingress(
  opts: {
    listens?: boolean
    dispatch?: (event: DomainEvent<any>) => Promise<string>
    openResult?: { ok: boolean; url?: string; error?: string }
    token?: string | undefined
    botUserId?: () => Promise<string>
  } = {},
) {
  FakeSocket.all = []
  const dispatched: DomainEvent<any>[] = []
  const logs: string[] = []
  const mounted = {
    pipelines: () => (opts.listens === false ? [] : [{ on: ['slack.message'] }]) as never,
    engine: {
      dispatch:
        opts.dispatch ??
        (async (event: DomainEvent<any>) => {
          dispatched.push(event)
          return 'dispatched'
        }),
    },
  }
  const slack = { enabled: true, botUserId: opts.botUserId ?? (async () => 'UBOT') }
  const start = () =>
    startSlackIngress(mounted as never, slack, {
      appToken: () => ('token' in opts ? opts.token : 'xapp-1'),
      log: (line) => logs.push(line),
      socket: {
        fetchImpl: (async () =>
          new Response(
            JSON.stringify(opts.openResult ?? { ok: true, url: 'wss://slack.test' }),
          )) as never,
        webSocketImpl: FakeSocket as never,
      },
    })
  return { start, dispatched, logs }
}

/** Arranca el ingreso y contesta el `hello` de Slack. */
async function started(i: ReturnType<typeof ingress>) {
  const pending = i.start()
  await waitFor(() => expect(FakeSocket.all).toHaveLength(1))
  FakeSocket.all[0]?.receive({ type: 'hello' })
  return { handle: await pending, socket: FakeSocket.all[0] as FakeSocket }
}

describe('startSlackIngress', () => {
  it('does not start without an app token', async () => {
    expect(await ingress({ token: undefined }).start()).toBeUndefined()
    expect(FakeSocket.all).toEqual([])
  })

  it('dispatches each human message as slack.message when a pipeline listens', async () => {
    const i = ingress()
    const { socket } = await started(i)
    socket.receive(envelope('<@UBOT> crea un issue'))
    await waitFor(() => expect(i.dispatched).toHaveLength(1))
    expect(i.dispatched[0]?.type).toBe('slack.message')
    expect(i.dispatched[0]?.payload).toMatchObject({ author: 'U1', mentionsBot: true })
    expect(i.logs).toContain('→ escuchando Slack por Socket Mode')
  })

  it('drops the message silently when no pipeline listens to slack.message', async () => {
    const i = ingress({ listens: false })
    const { socket } = await started(i)
    socket.receive(envelope())
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(i.dispatched).toEqual([])
    expect(socket.sent).toEqual([{ envelope_id: 'e1' }])
  })

  it('logs a failed dispatch with its cause and keeps listening', async () => {
    let calls = 0
    const i = ingress({
      dispatch: async () => {
        calls++
        throw new AggregateError([new Error('sin acceso')], '1 pipeline(s) failed')
      },
    })
    const { socket } = await started(i)
    socket.receive(envelope('a', '1.1', 'e1'))
    socket.receive(envelope('b', '2.2', 'e2'))
    await waitFor(() => expect(calls).toBe(2))
    await waitFor(() =>
      expect(i.logs.some((l) => l.includes('el despacho falló') && l.includes('sin acceso'))).toBe(
        true,
      ),
    )
  })

  it('starts without the bot id when auth.test fails', async () => {
    const i = ingress({
      botUserId: async () => {
        throw new Error('invalid_auth')
      },
    })
    const { handle, socket } = await started(i)
    expect(handle).toBeDefined()
    socket.receive(envelope('<@UBOT> hola'))
    await waitFor(() => expect(i.dispatched).toHaveLength(1))
    expect(i.dispatched[0]?.payload.mentionsBot).toBe(false)
  })

  it('does not bring the runner down when Slack refuses the token', async () => {
    const i = ingress({ openResult: { ok: false, error: 'invalid_auth' } })
    expect(await i.start()).toBeUndefined()
    expect(i.logs.some((l) => l.includes('no arrancó') && l.includes('invalid_auth'))).toBe(true)
  })

  it('stop() closes the connection', async () => {
    const i = ingress()
    const { handle, socket } = await started(i)
    handle?.stop()
    expect(socket.closed).toBe(true)
  })
})
