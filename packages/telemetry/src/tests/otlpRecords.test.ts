import { describe, expect, it, vi } from 'vitest'
import { otlpLogs, otlpTraces, recordExporter } from '../otlpRecords.js'
import type { TraceRecord } from '../traceRecord.js'

const span = (over: Partial<TraceRecord> = {}): TraceRecord => ({
  kind: 'span',
  phase: 'end',
  name: 'chat claude-opus-5',
  startTime: '2026-09-30T10:00:00.000Z',
  endTime: '2026-09-30T10:00:01.500Z',
  durationMs: 1500,
  status: 'error',
  statusMessage: 'overloaded',
  traceId: 'a'.repeat(32),
  spanId: 'b'.repeat(16),
  parentSpanId: 'c'.repeat(16),
  executionId: 'exec-1',
  origin: 'gpu-box',
  attributes: { 'ia.agent.id': 'implementer', tokens: 120, ratio: 0.5, cached: true, tags: ['x'] },
  ...over,
})

const resource = { serviceName: 'runner', attributes: { 'deployment.environment.name': 'local' } }

describe('otlpTraces', () => {
  it('keeps the original ids, times and status — the span hangs from the runner agent span', () => {
    const [resourceSpans] = otlpTraces([span()], resource).resourceSpans
    expect(resourceSpans?.resource.attributes).toEqual(
      expect.arrayContaining([
        { key: 'service.name', value: { stringValue: 'runner' } },
        { key: 'ia.origin', value: { stringValue: 'gpu-box' } },
      ]),
    )
    expect(resourceSpans?.scopeSpans[0]?.spans[0]).toMatchObject({
      traceId: 'a'.repeat(32),
      spanId: 'b'.repeat(16),
      parentSpanId: 'c'.repeat(16),
      startTimeUnixNano: '1790762400000000000',
      endTimeUnixNano: '1790762401500000000',
      status: { code: 2, message: 'overloaded' },
      attributes: expect.arrayContaining([
        { key: 'tokens', value: { intValue: '120' } },
        { key: 'ratio', value: { doubleValue: 0.5 } },
        { key: 'cached', value: { boolValue: true } },
        { key: 'tags', value: { arrayValue: { values: [{ stringValue: 'x' }] } } },
      ]),
    })
  })

  it('only exports finished spans, grouped by the host they came from', () => {
    const traces = otlpTraces(
      [span({ phase: 'start' }), span(), span({ origin: 'other', spanId: 'd'.repeat(16) })],
      resource,
    )
    expect(traces.resourceSpans).toHaveLength(2)
    expect(traces.resourceSpans.map((r) => r.scopeSpans[0]?.spans.length)).toEqual([1, 1])
  })
})

describe('otlpLogs', () => {
  it('a log keeps its level, message, scope and span', () => {
    const log = span({
      kind: 'log',
      phase: undefined,
      name: 'tool "Bash"',
      level: 'warn',
      scope: 'claude-cli',
    })
    const record = otlpLogs([log], resource).resourceLogs[0]?.scopeLogs[0]?.logRecords[0]
    expect(record).toMatchObject({
      severityNumber: 13,
      severityText: 'WARN',
      body: { stringValue: 'tool "Bash"' },
      traceId: 'a'.repeat(32),
      spanId: 'b'.repeat(16),
      attributes: expect.arrayContaining([
        { key: 'otel.scope.name', value: { stringValue: 'claude-cli' } },
      ]),
    })
    expect(otlpTraces([log], resource).resourceSpans).toEqual([])
  })
})

describe('recordExporter', () => {
  it('batches to /v1/traces and /v1/logs; a collector down is reported, never thrown', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith('/v1/logs') ? new Response('', { status: 503 }) : new Response('{}'),
    )
    const errors: unknown[] = []
    const exporter = recordExporter({
      endpoint: 'http://collector:4318/',
      resource,
      flushMs: 60_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onError: (err) => errors.push(err),
    })
    exporter.write(span())
    exporter.write(span({ kind: 'log', phase: undefined, level: 'info' }))
    expect(fetchImpl).not.toHaveBeenCalled()

    await exporter.flush()

    expect(fetchImpl.mock.calls.map(([url]) => String(url)).sort()).toEqual([
      'http://collector:4318/v1/logs',
      'http://collector:4318/v1/traces',
    ])
    expect(String(errors[0])).toContain('/v1/logs: HTTP 503')
    await exporter.flush()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})
