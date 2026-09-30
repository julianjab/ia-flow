import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  backoffMs,
  connectRunnerStream,
  type EventSourceLike,
  FALLBACK_AFTER,
  parseStreamEvent,
  type StreamState,
} from '../stream'

class FakeSource implements EventSourceLike {
  static all: FakeSource[] = []
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  closed = false
  constructor(readonly url: string) {
    FakeSource.all.push(this)
  }
  close() {
    this.closed = true
  }
}

const last = () => FakeSource.all.at(-1) as FakeSource

describe('parseStreamEvent', () => {
  it('acepta los tres tipos del contrato', () => {
    expect(parseStreamEvent(JSON.stringify({ type: 'inbox', refs: ['a/b#1'] }))).toEqual({
      type: 'inbox',
      refs: ['a/b#1'],
    })
  })

  it('ignora JSON roto y eventos que no cumplen el contrato', () => {
    expect(parseStreamEvent('no es json')).toBeNull()
    expect(parseStreamEvent(JSON.stringify({ type: 'inbox' }))).toBeNull()
    expect(parseStreamEvent(JSON.stringify({ type: 'otra-cosa' }))).toBeNull()
  })
})

describe('backoffMs', () => {
  it('duplica desde 1 s y topa en 30 s', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => backoffMs(n))).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000,
    ])
  })
})

describe('connectRunnerStream', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    FakeSource.all = []
  })
  afterEach(() => vi.useRealTimers())

  function setup() {
    const states: StreamState[] = []
    const events: unknown[] = []
    const onPoll = vi.fn()
    const handle = connectRunnerStream({
      url: () => 'http://x/api/stream?token=t',
      onEvent: (e) => events.push(e),
      onState: (s) => states.push(s),
      onPoll,
      createSource: (url) => new FakeSource(url),
    })
    return { states, events, onPoll, handle }
  }

  it('conecta a la URL, pasa a live y entrega eventos válidos', () => {
    const { states, events } = setup()
    expect(last().url).toBe('http://x/api/stream?token=t')
    last().onopen?.({})
    last().onmessage?.({ data: JSON.stringify({ type: 'inbox', refs: ['a/b#1'] }) })
    last().onmessage?.({ data: 'basura' })
    expect(states).toEqual(['connecting', 'live'])
    expect(events).toEqual([{ type: 'inbox', refs: ['a/b#1'] }])
  })

  it('al caerse reintenta con backoff y vuelve a live', () => {
    const { states } = setup()
    last().onerror?.({})
    expect(states.at(-1)).toBe('reconnecting')
    expect(FakeSource.all).toHaveLength(1)

    vi.advanceTimersByTime(1000)
    expect(FakeSource.all).toHaveLength(2)
    last().onopen?.({})
    expect(states.at(-1)).toBe('live')
  })

  it('tras varias fallas seguidas cae a polling cada 30 s y se apaga al reconectar', () => {
    const { states, onPoll } = setup()
    for (let i = 0; i < FALLBACK_AFTER; i++) {
      last().onerror?.({})
      vi.advanceTimersByTime(30_000)
    }
    expect(states).toContain('polling')
    onPoll.mockClear()
    vi.advanceTimersByTime(30_000)
    expect(onPoll).toHaveBeenCalled()

    last().onopen?.({})
    expect(states.at(-1)).toBe('live')
    onPoll.mockClear()
    vi.advanceTimersByTime(90_000)
    expect(onPoll).not.toHaveBeenCalled()
  })

  it('close() corta la conexión, el reintento y el polling', () => {
    const { handle, onPoll } = setup()
    last().onerror?.({})
    handle.close()
    const count = FakeSource.all.length
    vi.advanceTimersByTime(120_000)
    expect(FakeSource.all).toHaveLength(count)
    expect(onPoll).not.toHaveBeenCalled()
  })
})
