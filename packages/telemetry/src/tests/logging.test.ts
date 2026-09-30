import { context, trace } from '@opentelemetry/api'
import { logs } from '@opentelemetry/api-logs'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  addLogSink,
  consoleSink,
  createLogger,
  isLogLevelEnabled,
  type LogRecord,
  otelSink,
  parseLogLevel,
  setLogLevel,
  setLogSinks,
} from '../logging.js'
import { withInheritedAttributes, withSpan } from '../tracing.js'

const exported = new InMemoryLogRecordExporter()

beforeAll(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(new InMemorySpanExporter())],
    }),
  )
  logs.setGlobalLoggerProvider(
    new LoggerProvider({ processors: [new SimpleLogRecordProcessor({ exporter: exported })] }),
  )
})

afterAll(() => {
  trace.disable()
  logs.disable()
  context.disable()
})

beforeEach(() => exported.reset())
afterEach(() => {
  setLogSinks([otelSink()])
  setLogLevel('info')
  vi.restoreAllMocks()
})

/** Un sink que junta lo que recibe. */
function collector(): { sink: (record: LogRecord) => void; records: LogRecord[] } {
  const records: LogRecord[] = []
  return { sink: (record) => records.push(record), records }
}

describe('createLogger', () => {
  it('goes to OTel by default, under the logger scope', () => {
    createLogger('engine').warn('ojo', { 'ia.x': 1 })

    const [record] = exported.getFinishedLogRecords()
    expect(record?.body).toBe('ojo')
    expect(record?.severityText).toBe('WARN')
    expect(record?.attributes).toEqual({ 'ia.x': 1 })
    expect(record?.instrumentationScope.name).toBe('engine')
  })

  it('defaults the scope to the package name', () => {
    const { sink, records } = collector()
    setLogSinks([sink])

    createLogger().info('hola')

    expect(records[0]).toMatchObject({ level: 'info', scope: '@ia-flow/telemetry' })
  })

  it('fans every log out to all the sinks, with inherited attributes and the trace ids', async () => {
    const a = collector()
    const b = collector()
    setLogSinks([a.sink, b.sink])
    const log = createLogger('pipeline')

    let spanIds: { traceId: string; spanId: string } | undefined
    await withInheritedAttributes({ 'ia.issue': 'x#1' }, () =>
      withSpan('step', {}, async (span) => {
        spanIds = span.spanContext()
        log.info('corre', { 'ia.step.id': 'mark' })
      }),
    )

    expect(a.records).toEqual(b.records)
    expect(a.records[0]).toMatchObject({
      level: 'info',
      scope: 'pipeline',
      message: 'corre',
      attributes: { 'ia.issue': 'x#1', 'ia.step.id': 'mark' },
      traceId: spanIds?.traceId,
      spanId: spanIds?.spanId,
    })
    expect(a.records[0]?.time).toBeInstanceOf(Date)
    expect(exported.getFinishedLogRecords()).toHaveLength(0)
  })

  it('resolves the sinks when logging, so loggers created before the setup still follow it', () => {
    const log = createLogger('early')
    const { sink, records } = collector()
    setLogSinks([sink])

    log.error('tarde')

    expect(records.map((r) => r.message)).toEqual(['tarde'])
    expect(records[0]).not.toHaveProperty('traceId')
  })

  it('keeps logging to the other sinks when one throws', () => {
    const { sink, records } = collector()
    setLogSinks([
      () => {
        throw new Error('roto')
      },
      sink,
    ])

    expect(() => createLogger('x').info('sigue')).not.toThrow()
    expect(records).toHaveLength(1)
  })

  it('addLogSink adds to the current sinks and returns how to remove it', () => {
    const { sink, records } = collector()
    const remove = addLogSink(sink)
    const log = createLogger('x')

    log.info('uno')
    remove()
    log.info('dos')

    expect(records.map((r) => r.message)).toEqual(['uno'])
    expect(exported.getFinishedLogRecords().map((r) => r.body)).toEqual(['uno', 'dos'])
  })
})

describe('consoleSink', () => {
  const record = (overrides: Partial<LogRecord> = {}): LogRecord => ({
    time: new Date('2026-09-25T17:04:05.678Z'),
    level: 'info',
    scope: 'engine',
    message: 'corren refine',
    attributes: { 'ia.issue': 'x#1', 'ia.pipelines.skipped': ['build (no cumple)'] },
    ...overrides,
  })

  it('prints one readable line with the scope and the attributes', () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {})

    consoleSink()(record())

    expect(out).toHaveBeenCalledWith(
      '17:04:05.678 INFO  [engine] corren refine ia.issue=x#1 ia.pipelines.skipped=["build (no cumple)"]',
    )
  })

  it('omits the attribute list when there is none', () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {})

    consoleSink()(record({ attributes: {} }))

    expect(out).toHaveBeenCalledWith('17:04:05.678 INFO  [engine] corren refine')
  })

  it('prints one JSON line per record in json format', () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {})

    consoleSink({ format: 'json' })(record())

    expect(JSON.parse(out.mock.calls[0]?.[0] as string)).toMatchObject({
      level: 'info',
      scope: 'engine',
      message: 'corren refine',
    })
  })

  it('routes warn and error to console.warn / console.error', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const sink = consoleSink()

    sink(record({ level: 'warn' }))
    sink(record({ level: 'error' }))

    expect(warn).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledTimes(1)
  })

  it('drops what is below its level (info by default)', () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {})

    consoleSink()(record({ level: 'debug' }))
    consoleSink({ level: 'debug' })(record({ level: 'debug' }))

    expect(out).toHaveBeenCalledTimes(1)
  })
})

describe('setLogLevel', () => {
  it('drops debug by default, for every sink', () => {
    const { sink, records } = collector()
    setLogSinks([sink])

    createLogger('x').debug('ruido')

    expect(records).toEqual([])
    expect(isLogLevelEnabled('debug')).toBe(false)
  })

  it('lets debug through once the app asks for it', () => {
    const { sink, records } = collector()
    setLogSinks([sink])
    setLogLevel('debug')

    createLogger('x').debug('detalle')

    expect(records[0]).toMatchObject({ level: 'debug', message: 'detalle' })
    expect(isLogLevelEnabled('debug')).toBe(true)
  })

  it('drops everything under the minimum', () => {
    const { sink, records } = collector()
    setLogSinks([sink])
    setLogLevel('warn')

    const log = createLogger('x')
    log.info('no')
    log.warn('sí')

    expect(records.map((record) => record.message)).toEqual(['sí'])
  })
})

describe('parseLogLevel', () => {
  it('reads a level whatever its case, and rejects anything else', () => {
    expect(parseLogLevel(' DEBUG ')).toBe('debug')
    expect(parseLogLevel('warn')).toBe('warn')
    expect(parseLogLevel('verbose')).toBeUndefined()
    expect(parseLogLevel(undefined)).toBeUndefined()
  })
})
