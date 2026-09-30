import { context, trace } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createLogger, otelSink, setLogSinks } from '../logging.js'
import type { TraceRecord } from '../traceRecord.js'
import { traceRecorder } from '../traceRecorder.js'
import { markError, withInheritedAttributes, withSpan } from '../tracing.js'

const records: TraceRecord[] = []
let failing = false
const recorder = traceRecorder(
  {
    write: (record) => {
      if (failing) throw new Error('disco lleno')
      records.push(record)
    },
  },
  { origin: 'test', maxStringLength: 8 },
)

beforeAll(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({ spanProcessors: [recorder.spanProcessor] }),
  )
})

afterAll(() => {
  trace.disable()
  context.disable()
})

beforeEach(() => {
  records.length = 0
  failing = false
})
afterEach(() => setLogSinks([otelSink()]))

const spansNamed = (name: string) =>
  records.filter((record) => record.kind === 'span' && record.name === name)

/** Una corrida como la arma el engine: `pipeline <id>` hereda `ia.execution.id` a lo de adentro. */
const inExecution = <T>(fn: () => Promise<T>) =>
  withInheritedAttributes({ 'ia.execution.id': 'exec-1' }, () => withSpan('pipeline build', {}, fn))

describe('traceRecorder', () => {
  it('records every span of an execution at start and end, with status and duration', async () => {
    await inExecution(() =>
      withSpan('agent implementer', { 'ia.agent.id': 'implementer' }, async (span) => {
        span.setAttribute('ia.agent.exit', 'done')
      }),
    )

    const agent = spansNamed('agent implementer')
    expect(agent.map((record) => record.phase)).toEqual(['start', 'end'])
    const [start, end] = agent as [TraceRecord, TraceRecord]
    expect(start).toMatchObject({ executionId: 'exec-1', origin: 'test' })
    expect(start.endTime).toBeUndefined()
    // Lo que se suma después de abrir el span llega al terminar.
    expect(start.attributes['ia.agent.exit']).toBeUndefined()
    expect(end).toMatchObject({ status: 'unset', attributes: { 'ia.agent.exit': 'done' } })
    expect(end.durationMs).toBeGreaterThanOrEqual(0)
    expect(Date.parse(end.endTime as string)).toBeGreaterThanOrEqual(Date.parse(end.startTime))
    const pipeline = spansNamed('pipeline build')[0] as TraceRecord
    expect(start.parentSpanId).toBe(pipeline.spanId)
    expect(start.traceId).toBe(pipeline.traceId)
  })

  it('a child span without ia.execution.id belongs to the execution of its parent', async () => {
    await inExecution(async () => {
      // Una tool instrumentada por su cuenta: sin los atributos heredados.
      const tool = trace.getTracer('some-lib').startSpan('tool fs_read')
      tool.end()
      await context.with(trace.setSpan(context.active(), tool), async () => {
        trace.getTracer('some-lib').startSpan('nested').end()
      })
    })

    expect(spansNamed('tool fs_read').map((record) => record.executionId)).toEqual([
      'exec-1',
      'exec-1',
    ])
    expect(spansNamed('tool fs_read')[0]?.attributes['ia.execution.id']).toBeUndefined()
    expect(spansNamed('nested')).toHaveLength(2)
  })

  it('records a failed span with its error', async () => {
    await inExecution(() =>
      withSpan('agent a', {}, async (span) => {
        markError(span, new Error('no'))
      }),
    )
    expect(spansNamed('agent a')[1]).toMatchObject({ status: 'error', statusMessage: 'no' })
  })

  it('ignores spans outside any execution', async () => {
    await withSpan('event build', {}, async () => {
      await withSpan('plan', {}, async () => null)
    })
    expect(records).toEqual([])
  })

  it('truncates long strings (and list items) and drops what cannot be stored', async () => {
    await inExecution(() =>
      withSpan(
        'agent a',
        { long: 'x'.repeat(20), list: ['short', 'y'.repeat(20)], n: 3, ok: true },
        async () => null,
      ),
    )
    const { attributes } = spansNamed('agent a')[0] as TraceRecord
    expect(attributes.long).toBe('xxxxxxxx… (+12)')
    expect(attributes.list).toEqual(['short', 'yyyyyyyy… (+12)'])
    expect(attributes.n).toBe(3)
    expect(attributes.ok).toBe(true)
  })

  it('records the logs of an execution — by attribute or by the span they run in', async () => {
    setLogSinks([recorder.logSink])
    const log = createLogger('agent-engine.engine')

    await inExecution(async () => {
      log.info('abre', { detalle: 'z'.repeat(20) })
    })
    log.warn('suelto')
    log.warn('con id, sin span', { 'ia.execution.id': 'exec-2' })

    const logs = records.filter((record) => record.kind === 'log')
    expect(logs).toHaveLength(2)
    expect(logs[0]).toMatchObject({
      name: 'abre',
      scope: 'agent-engine.engine',
      level: 'info',
      executionId: 'exec-1',
      origin: 'test',
      attributes: { detalle: 'zzzzzzzz… (+12)', 'ia.execution.id': 'exec-1' },
    })
    expect(logs[0]?.spanId).toBe(spansNamed('pipeline build')[0]?.spanId)
    expect(logs[1]).toMatchObject({ executionId: 'exec-2', traceId: '', spanId: '' })
  })

  it('never throws when the journal does', async () => {
    failing = true
    setLogSinks([recorder.logSink])
    await expect(
      inExecution(async () => {
        createLogger('x').info('hola')
        return 'ok'
      }),
    ).resolves.toBe('ok')
  })
})
