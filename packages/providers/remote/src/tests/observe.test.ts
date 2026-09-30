import type { ExecutionHandle, ProviderRunContext } from '@ia-flow/agent-engine'
import {
  addLogSink,
  createLogger,
  type LogRecord,
  type TraceRecord,
  withInheritedAttributes,
  withSpan,
} from '@ia-flow/telemetry'
import { context, trace } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { RunEvent, RunRequest } from '../protocol.js'
import type { RemoteProviderHost } from '../RemoteProviderHost.js'
import { activeTraceparent, contextFromTraceparent } from '../traceContext.js'
import {
  call,
  delay,
  makeClient,
  makeHost,
  runContext,
  ScriptedProvider,
  tool,
  wire,
} from './fixtures.js'

const spans = new InMemorySpanExporter()
const logs: LogRecord[] = []
let removeSink: () => void

beforeAll(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spans)] }),
  )
  removeSink = addLogSink((record) => logs.push(record))
})
afterAll(() => {
  removeSink()
  trace.disable()
  context.disable()
})
beforeEach(() => {
  spans.reset()
  logs.length = 0
})

function record(name: string, executionId = 'exec-1', origin = 'runner'): TraceRecord {
  return {
    kind: 'span',
    phase: 'end',
    name,
    status: 'ok',
    startTime: '2026-09-29T00:00:00.000Z',
    endTime: '2026-09-29T00:00:01.000Z',
    durationMs: 1000,
    traceId: 'a'.repeat(32),
    spanId: 'b'.repeat(16),
    executionId,
    origin,
    attributes: { 'gen_ai.usage.output_tokens': 7, tags: ['x'] },
  }
}

/** Un contexto de corrida dentro de la ejecución `exec-1`. */
function inExecution(overrides: Partial<ProviderRunContext> = {}): ProviderRunContext {
  const base = runContext(overrides)
  return { ...base, ctx: { ...base.ctx, execution: { id: 'exec-1' } as ExecutionHandle } }
}

/** Un fetch al host que anota el body de cada `POST …/runs`. */
function recordingWire(host: RemoteProviderHost, bodies: unknown[]): typeof fetch {
  const inner = wire(host)
  return (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith('/runs') && typeof init?.body === 'string') {
      bodies.push(JSON.parse(init.body))
    }
    return inner(input, init)
  }) as typeof fetch
}

describe('protocol — observe', () => {
  it('round-trips the trace and text events, and the new RunRequest fields are optional', () => {
    const events = [
      { seq: 1, type: 'trace', record: record('chat claude') },
      { seq: 2, type: 'text', delta: 'hola' },
    ]
    expect(events.map((event) => RunEvent.parse(JSON.parse(JSON.stringify(event))))).toEqual(events)
    expect(() => RunEvent.parse({ seq: 3, type: 'trace', record: { name: 'x' } })).toThrow()

    const request = {
      agentId: 'a',
      prompt: 'p',
      systemPrompts: [],
      variables: {},
      providerConfig: {},
      mcpServers: [],
      tools: [],
      context: {
        event: { type: 't', payload: {}, occurredAt: 'x', depth: 0 },
        pipelineId: 'p',
      },
      hints: {},
      inbox: false,
      saveConversation: false,
    }
    expect(RunRequest.parse(request).observe).toBeUndefined()
    const observed = RunRequest.parse({
      ...request,
      observe: true,
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    })
    expect(observed.observe).toBe(true)
    expect(observed.traceparent).toBe('00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01')
  })
})

describe('traceparent', () => {
  it('is written from the active span and read back as its remote parent', async () => {
    await withSpan('agent x', {}, async (span) => {
      const traceparent = activeTraceparent()
      const { traceId, spanId } = span.spanContext()
      expect(traceparent).toBe(`00-${traceId}-${spanId}-01`)
      const parent = contextFromTraceparent(traceparent)
      expect(parent && trace.getSpanContext(parent)).toMatchObject({
        traceId,
        spanId,
        isRemote: true,
      })
    })
    expect(activeTraceparent()).toBeUndefined()
    expect(contextFromTraceparent(undefined)).toBeUndefined()
    expect(contextFromTraceparent('00-nope')).toBeUndefined()
    expect(contextFromTraceparent(`00-${'0'.repeat(32)}-${'0'.repeat(16)}-01`)).toBeUndefined()
  })
})

describe('RemoteProvider — la traza cruza', () => {
  it('runs the host provider as a child of the agent span, tagged with the runner execution', async () => {
    const hostLog = createLogger('host-provider')
    const local = new ScriptedProvider('local', async () => {
      await withSpan('chat claude-opus-5', {}, async () => hostLog.info('pensando'))
      return { outcome: 'success' }
    })
    let agentSpan: { traceId: string; spanId: string } | undefined
    await withInheritedAttributes({ 'ia.execution.id': 'exec-1' }, () =>
      withSpan('agent implementer', {}, async (span) => {
        agentSpan = span.spanContext()
        await makeClient(makeHost([local])).run(inExecution())
      }),
    )

    const chat = spans.getFinishedSpans().find((span) => span.name === 'chat claude-opus-5')
    expect(chat?.spanContext().traceId).toBe(agentSpan?.traceId)
    expect(chat?.parentSpanContext?.spanId).toBe(agentSpan?.spanId)
    expect(chat?.attributes).toMatchObject({
      'ia.execution.id': 'exec-1',
      'ia.agent.id': 'implementer',
      'ia.projectId': 'p1',
    })
    const log = logs.find((entry) => entry.message === 'pensando')
    expect(log?.traceId).toBe(agentSpan?.traceId)
    expect(log?.attributes['ia.execution.id']).toBe('exec-1')
  })
})

describe('RemoteProvider — observe (opt-in)', () => {
  it('an unobserved run never gets trace events, and does not ask for them', async () => {
    let host!: RemoteProviderHost
    const local = new ScriptedProvider('local', async (ctx) => {
      host.trace(record('ignorado'))
      expect(ctx.onText).toBeUndefined()
      return { outcome: 'success' }
    })
    host = makeHost([local])
    const bodies: unknown[] = []
    const output = await makeClient(recordingWire(host, bodies)).run(inExecution())
    expect(output.outcome).toBe('success')
    expect((bodies[0] as { observe?: boolean }).observe).toBeUndefined()
  })

  it('delivers every record and text once, in order, before the end — only of its execution', async () => {
    let host!: RemoteProviderHost
    const local = new ScriptedProvider('local', async (ctx) => {
      host.trace(record('uno'))
      host.trace(record('de otra ejecución', 'exec-2'))
      ctx.onText?.('ho')
      // Que un sync vuelva en el medio: lo ya reconocido no se repite.
      await delay(30)
      await call(ctx, 'read_issue')
      host.trace(record('dos', 'exec-1', 'gpu-host'))
      ctx.onText?.('la')
      return { outcome: 'success' }
    })
    host = makeHost([local])
    const traces: TraceRecord[] = []
    const texts: string[] = []
    const bodies: unknown[] = []

    const output = await makeClient(recordingWire(host, bodies), {
      onTrace: (entry) => traces.push(entry),
    }).run(
      inExecution({
        tools: [tool('read_issue', () => 'el issue')],
        onText: (delta) => texts.push(delta),
      }),
    )

    expect(output.outcome).toBe('success')
    expect((bodies[0] as { observe?: boolean }).observe).toBe(true)
    expect(traces.map((entry) => [entry.name, entry.origin])).toEqual([
      ['uno', 'remote'],
      ['dos', 'gpu-host'],
    ])
    expect(traces[0]?.attributes).toEqual({ 'gen_ai.usage.output_tokens': 7, tags: ['x'] })
    expect(texts).toEqual(['ho', 'la'])
  })

  it('a long-poll in wait returns as soon as a record is queued', async () => {
    let release!: () => void
    const local = new ScriptedProvider('local', async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return { outcome: 'success' }
    })
    const host = makeHost([local])
    const traces: TraceRecord[] = []
    const client = makeClient(host, {
      onTrace: (entry) => traces.push(entry),
      timing: { longPollMs: 5_000, requestSlackMs: 5_000, retryDelayMs: 10 },
    })
    const running = client.run(inExecution())
    await delay(30)
    const at = Date.now()
    host.trace(record('en vivo'))
    while (traces.length === 0 && Date.now() - at < 2_000) await delay(5)
    expect(traces.map((entry) => entry.name)).toEqual(['en vivo'])
    expect(Date.now() - at).toBeLessThan(1_000)
    release()
    await running
  })
})
