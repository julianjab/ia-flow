import { context, SpanStatusCode, trace } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLogger, otelSink, setLogSinks } from '../logging.js'
import {
  captureSpanLink,
  inFreshContext,
  scopeAttributes,
  tagged,
  taggedSync,
  traced,
  truncate,
  withInheritedAttributes,
  withSpan,
} from '../tracing.js'

const spans = new InMemorySpanExporter()

beforeAll(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spans)] }),
  )
})

afterAll(() => {
  trace.disable()
  context.disable()
})

beforeEach(() => spans.reset())
afterEach(() => setLogSinks([otelSink()]))

const byName = (name: string): ReadableSpan => {
  const span = spans.getFinishedSpans().find((s) => s.name === name)
  if (!span)
    throw new Error(`no hay span "${name}": ${spans.getFinishedSpans().map((s) => s.name)}`)
  return span
}
const parentOf = (span: ReadableSpan) => span.parentSpanContext?.spanId

describe('telemetry helpers', () => {
  it('turns only primitive scope values into ia.* attributes', () => {
    expect(scopeAttributes({ repo: 'r', issue: 7, nested: { a: 1 }, tags: ['a', 'b'] })).toEqual({
      'ia.repo': 'r',
      'ia.issue': 7,
      'ia.tags': ['a', 'b'],
    })
  })

  it('truncates long values and says how much it cut', () => {
    expect(truncate('x'.repeat(10), 4)).toBe('xxxx… (+6)')
    expect(truncate({ a: 1 })).toBe('{"a":1}')
  })

  it('inherited attributes reach spans opened deeper, and inner ones win', async () => {
    await withInheritedAttributes({ 'ia.repo': 'a', 'ia.x': 1 }, () =>
      withInheritedAttributes({ 'ia.repo': 'b' }, () => withSpan('inner', {}, async () => null)),
    )

    expect(byName('inner').attributes).toMatchObject({ 'ia.repo': 'b', 'ia.x': 1 })
  })

  it('rethrows and marks the span when the wrapped work fails', async () => {
    await expect(
      withSpan('boom', {}, async () => {
        throw new Error('no')
      }),
    ).rejects.toThrow('no')

    expect(byName('boom').status).toEqual({ code: SpanStatusCode.ERROR, message: 'no' })
  })
})

describe('@traced / @tagged', () => {
  class Worker {
    readonly id = 'w1'

    @traced<Worker, [number], number>({
      name(n) {
        return `work ${this.id} ${n}`
      },
      inherit: (n) => ({ 'ia.n': n }),
      attributes: () => ({ 'ia.phase': 'start' }),
      onResult: (span, result) => span.setAttribute('ia.result', result),
    })
    async work(n: number): Promise<number> {
      return this.inner(n * 2)
    }

    @tagged<Worker, [number], number>({
      attributes: (n) => ({ 'ia.inner.input': n }),
      onResult: (span, result) => span.addEvent('inner.done', { 'ia.inner.result': result }),
    })
    private async inner(n: number): Promise<number> {
      await withSpan('child', {}, async () => null)
      return n + 1
    }

    @traced()
    async fail(): Promise<void> {
      throw new Error('falló')
    }
  }

  it('opens a span named from the arguments and `this`, and records the result', async () => {
    expect(await new Worker().work(3)).toBe(7)

    const span = byName('work w1 3')
    expect(span.attributes).toMatchObject({ 'ia.n': 3, 'ia.phase': 'start', 'ia.result': 7 })
    // Lo heredado llega a los spans de adentro.
    expect(byName('child').attributes['ia.n']).toBe(3)
    expect(parentOf(byName('child'))).toBe(span.spanContext().spanId)
  })

  it('@tagged adds to the active span instead of opening one', async () => {
    await new Worker().work(3)

    const span = byName('work w1 3')
    expect(span.attributes['ia.inner.input']).toBe(6)
    expect(span.events.map((e) => [e.name, e.attributes])).toEqual([
      ['inner.done', { 'ia.inner.result': 7 }],
    ])
    expect(spans.getFinishedSpans().map((s) => s.name)).toEqual(['child', 'work w1 3'])
  })

  it('defaults the name to Class.method, marks the span and rethrows on failure', async () => {
    await expect(new Worker().fail()).rejects.toThrow('falló')

    expect(byName('Worker.fail').status).toEqual({ code: SpanStatusCode.ERROR, message: 'falló' })
  })
})

describe('@taggedSync / links / inFreshContext', () => {
  class Relay {
    @taggedSync<Relay, [number], string>({
      onResult: (span, result, n) => span.addEvent('decided', { 'ia.n': n, 'ia.result': result }),
    })
    decide(n: number): string {
      return n > 0 ? 'go' : 'stop'
    }

    @traced<Relay, [ReturnType<typeof captureSpanLink>], void>({
      name: 'later',
      links: (origin) => (origin ? [origin] : []),
    })
    async later(_origin: ReturnType<typeof captureSpanLink>): Promise<void> {}
  }

  it('@taggedSync records on the active span before returning, without yielding', async () => {
    const relay = new Relay()
    await withSpan('outer', {}, async () => {
      expect(relay.decide(2)).toBe('go')
    })
    expect(byName('outer').events.map((e) => [e.name, e.attributes])).toEqual([
      ['decided', { 'ia.n': 2, 'ia.result': 'go' }],
    ])
    // Sin span activo no hace nada.
    expect(relay.decide(0)).toBe('stop')
  })

  it('inFreshContext starts a new trace that links back to the captured span', async () => {
    const relay = new Relay()
    let origin: ReturnType<typeof captureSpanLink>
    let later: Promise<void> | undefined
    await withInheritedAttributes({ 'ia.issue': 7 }, () =>
      withSpan('origin', {}, async () => {
        origin = captureSpanLink()
        later = inFreshContext(() => relay.later(origin))
      }),
    )
    await later

    const span = byName('later')
    expect(parentOf(span)).toBeUndefined()
    expect(span.spanContext().traceId).not.toBe(byName('origin').spanContext().traceId)
    expect(span.links.map((link) => link.context.spanId)).toEqual([
      byName('origin').spanContext().spanId,
    ])
    // Tampoco arrastra lo heredado del contexto de donde se disparó.
    expect(span.attributes['ia.issue']).toBeUndefined()
    expect(captureSpanLink()).toBeUndefined()
  })
})

describe('@traced with a `log` field', () => {
  class Job {
    readonly log = createLogger('job')

    @traced({ name: 'outer' })
    async outer(fail: unknown): Promise<void> {
      await this.inner(fail)
    }

    @traced({ name: 'inner' })
    async inner(fail: unknown): Promise<void> {
      throw fail
    }
  }

  class Silent {
    @traced({ name: 'silent' })
    async run(): Promise<void> {
      throw new Error('nadie lo loguea')
    }
  }

  it('logs an escaping error once, from the innermost span, and still rethrows', async () => {
    const sink = vi.fn()
    setLogSinks([sink])

    await expect(new Job().outer(new TypeError('se rompió'))).rejects.toThrow('se rompió')

    expect(sink).toHaveBeenCalledTimes(1)
    const [record] = sink.mock.calls[0] ?? []
    expect(record).toMatchObject({
      level: 'error',
      scope: 'job',
      message: 'inner falló: se rompió',
      attributes: { 'exception.type': 'TypeError' },
      spanId: byName('inner').spanContext().spanId,
    })
  })

  it('logs a thrown non-Error too', async () => {
    const sink = vi.fn()
    setLogSinks([sink])

    await expect(new Job().inner('texto')).rejects.toBe('texto')

    expect(sink.mock.calls[0]?.[0]).toMatchObject({
      message: 'inner falló: texto',
      attributes: { 'exception.type': 'string' },
    })
  })

  it('does not log when the instance has no logger', async () => {
    const sink = vi.fn()
    setLogSinks([sink])

    await expect(new Silent().run()).rejects.toThrow()

    expect(sink).not.toHaveBeenCalled()
    expect(byName('silent').status.code).toBe(SpanStatusCode.ERROR)
  })
})
