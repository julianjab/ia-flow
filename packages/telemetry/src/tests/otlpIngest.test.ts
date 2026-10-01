import { context, trace } from '@opentelemetry/api'
import { logs } from '@opentelemetry/api-logs'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { JsonLogsSerializer, JsonTraceSerializer } from '@opentelemetry/otlp-transformer'
import { resourceFromAttributes } from '@opentelemetry/resources'
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from '@opentelemetry/sdk-logs'
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createLogger, otelSink, setLogSinks } from '../logging.js'
import { recordsFromOtlpLogs, recordsFromOtlpTraces } from '../otlpIngest.js'
import { exportTraceContext, withRemoteTraceContext } from '../remoteContext.js'
import { withInheritedAttributes, withSpan } from '../tracing.js'

/** Lo que exporta un host: su SDK, con su resource, en memoria. */
const resource = resourceFromAttributes({
  'service.name': 'ai-development-flow-runner',
  'service.instance.id': 'laptop',
  'ia.origin': 'laptop',
})
const spans = new InMemorySpanExporter()
const logRecords = new InMemoryLogRecordExporter()

beforeAll(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({ resource, spanProcessors: [new SimpleSpanProcessor(spans)] }),
  )
  logs.setGlobalLoggerProvider(
    new LoggerProvider({
      resource,
      processors: [new SimpleLogRecordProcessor({ exporter: logRecords })],
    }),
  )
  setLogSinks([otelSink()])
})
afterAll(() => {
  trace.disable()
  logs.disable()
  context.disable()
})
beforeEach(() => {
  spans.reset()
  logRecords.reset()
})

/** Lo que llega al runner: el JSON del exporter OTLP/HTTP estándar, tal cual. */
const tracesPayload = () =>
  JSON.parse(
    new TextDecoder().decode(JsonTraceSerializer.serializeRequest(spans.getFinishedSpans())),
  )
const logsPayload = () =>
  JSON.parse(
    new TextDecoder().decode(
      JsonLogsSerializer.serializeRequest(logRecords.getFinishedLogRecords()),
    ),
  )

describe('recordsFromOtlpTraces / recordsFromOtlpLogs', () => {
  it('turns what the standard exporter sends back into the records the runner stores', async () => {
    await withInheritedAttributes({ 'ia.execution.id': 'exec-1', 'ia.issue': 'x#1' }, () =>
      withSpan('workspace.prepare', { 'ia.repo': 'x' }, async () => {
        createLogger('workspace').warn('clone lento', { 'ia.ms': 1200 })
      }),
    )

    const [span] = recordsFromOtlpTraces(tracesPayload())
    const finished = spans.getFinishedSpans()[0]
    expect(span).toMatchObject({
      kind: 'span',
      phase: 'end',
      name: 'workspace.prepare',
      status: 'unset',
      traceId: finished?.spanContext().traceId,
      spanId: finished?.spanContext().spanId,
      executionId: 'exec-1',
      origin: 'laptop',
      attributes: { 'ia.issue': 'x#1', 'ia.repo': 'x' },
    })
    expect(span?.durationMs).toBeGreaterThanOrEqual(0)

    const [log] = recordsFromOtlpLogs(logsPayload())
    expect(log).toMatchObject({
      kind: 'log',
      name: 'clone lento',
      scope: 'workspace',
      level: 'warn',
      executionId: 'exec-1',
      origin: 'laptop',
      traceId: finished?.spanContext().traceId,
      attributes: { 'ia.issue': 'x#1', 'ia.ms': 1200 },
    })
  })

  it('keeps a failed span as error, with its message', async () => {
    await withInheritedAttributes({ 'ia.execution.id': 'exec-1' }, () =>
      withSpan('host.run', {}, async () => {
        throw new Error('sin disco')
      }),
    ).catch(() => {})

    expect(recordsFromOtlpTraces(tracesPayload())[0]).toMatchObject({
      status: 'error',
      statusMessage: 'sin disco',
    })
  })

  it('takes a child without the execution id from its parent in the same batch', async () => {
    await withInheritedAttributes({ 'ia.execution.id': 'exec-1' }, () =>
      withSpan('host.run', {}, async () => {
        // Un span abierto sin los atributos heredados (una librería instrumentada por su cuenta).
        trace.getTracer('lib').startActiveSpan('lib.call', (span) => span.end())
      }),
    )

    const names = recordsFromOtlpTraces(tracesPayload()).map((record) => record.name)
    expect(names.sort()).toEqual(['host.run', 'lib.call'])
  })

  it('drops what is not part of an execution', async () => {
    await withSpan('poll', {}, async () => {
      createLogger('host').info('suscrito')
    })

    expect(recordsFromOtlpTraces(tracesPayload())).toEqual([])
    expect(recordsFromOtlpLogs(logsPayload())).toEqual([])
  })
})

describe('exportTraceContext / withRemoteTraceContext', () => {
  it('hangs the remote work from the span that sent it, with the same inherited attributes', async () => {
    let sent: ReturnType<typeof exportTraceContext>
    await withInheritedAttributes({ 'ia.execution.id': 'exec-1', 'ia.agent.id': 'refiner' }, () =>
      withSpan('agent refiner', {}, async () => {
        sent = exportTraceContext()
      }),
    )
    const agent = spans.getFinishedSpans()[0]
    spans.reset()

    // Otro proceso: sin contexto propio, sólo lo que llegó por el cable.
    await context.with(context.active(), () =>
      withRemoteTraceContext(JSON.parse(JSON.stringify(sent)), () =>
        withSpan('host.run', {}, async () => {}),
      ),
    )

    const [remote] = spans.getFinishedSpans()
    expect(remote?.spanContext().traceId).toBe(agent?.spanContext().traceId)
    expect(remote?.parentSpanContext?.spanId).toBe(agent?.spanContext().spanId)
    expect(remote?.attributes).toMatchObject({
      'ia.execution.id': 'exec-1',
      'ia.agent.id': 'refiner',
    })
  })

  it('exports nothing without an active span, and runs as-is on a missing or bad context', async () => {
    expect(exportTraceContext()).toBeUndefined()
    expect(withRemoteTraceContext(undefined, () => 1)).toBe(1)
    expect(withRemoteTraceContext({ traceparent: 'basura', attributes: {} }, () => 2)).toBe(2)
  })
})
