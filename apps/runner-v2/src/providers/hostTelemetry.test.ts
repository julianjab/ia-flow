/**
 * La telemetría de un host, de punta a punta: el exporter OTLP/HTTP JSON estándar del SDK (el que
 * usa `startTelemetry` en `--host`) le manda al runner por HTTP, y el runner la anota en su base y
 * la reexporta a su collector.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import type { AddressInfo } from 'node:net'
import type { TraceRecord } from '@ia-flow/telemetry'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { BasicTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { hostTelemetryIngest, parseOtlpHeaders } from './hostTelemetry.js'
import { listenHosts, mountRemoteHosts } from './remoteHosts.js'

const TOKEN = 'secreto-de-hosts'
const closers: Array<() => void> = []
afterEach(() => {
  for (const close of closers.splice(0)) close()
})

/** Un collector falso: junta lo que le llega. */
function fakeCollector() {
  const received: Array<{ url: string; headers: Headers; body: unknown }> = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    received.push({
      url,
      headers: new Headers(init.headers),
      body: JSON.parse(String(init.body)),
    })
    return new Response('{}', { status: 200 })
  }) as unknown as typeof fetch
  return { received, fetchImpl }
}

describe('hostTelemetryIngest', () => {
  it('lo que un host exporta con el SDK llega a la base del runner y a su collector', async () => {
    const records: TraceRecord[] = []
    const collector = fakeCollector()
    const hub = mountRemoteHosts(
      hostTelemetryIngest(
        { write: (record) => records.push(record) },
        {
          endpoint: 'http://collector.test:4318/',
          headers: 'dd-api-key=abc%3D,x-team=ia',
          fetchImpl: collector.fetchImpl,
        },
      ),
      TOKEN,
    )
    const server = await listenHosts(hub, 0, () => {})
    closers.push(
      () => server.close(),
      () => hub.close(),
    )
    const port = (server.address() as AddressInfo).port

    // El host: su SDK, con el exporter JSON apuntando al runner.
    const provider = new BasicTracerProvider({
      resource: resourceFromAttributes({
        'service.name': 'ai-development-flow-runner',
        'service.instance.id': 'laptop',
        'ia.origin': 'laptop',
      }),
      spanProcessors: [
        new SimpleSpanProcessor(
          new OTLPTraceExporter({
            url: `http://localhost:${port}/v1/hosts/telemetry/traces`,
            headers: { authorization: `Bearer ${TOKEN}` },
          }),
        ),
      ],
    })
    const tracer = provider.getTracer('workspace')
    tracer.startSpan('workspace.prepare', { attributes: { 'ia.execution.id': 'exec-1' } }).end()
    tracer.startSpan('poll').end()
    await provider.forceFlush()
    await provider.shutdown()

    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      kind: 'span',
      phase: 'end',
      name: 'workspace.prepare',
      executionId: 'exec-1',
      origin: 'laptop',
    })
    // Al collector va todo, tal cual (también lo que no es de una ejecución): un envío por span.
    expect(collector.received.map((sent) => sent.url)).toEqual([
      'http://collector.test:4318/v1/traces',
      'http://collector.test:4318/v1/traces',
    ])
    const [first] = collector.received
    expect(first?.headers.get('dd-api-key')).toBe('abc=')
    expect(first?.headers.get('x-team')).toBe('ia')
    expect(JSON.stringify(collector.received.map((sent) => sent.body))).toContain('"poll"')
  })

  it('sin collector, sólo anota', async () => {
    const records: TraceRecord[] = []
    const collector = fakeCollector()
    const ingest = hostTelemetryIngest(
      { write: (record) => records.push(record) },
      { fetchImpl: collector.fetchImpl },
    )

    await ingest('logs', {
      resourceLogs: [
        {
          scopeLogs: [
            {
              scope: { name: 'host' },
              logRecords: [
                {
                  timeUnixNano: '1790000000000000000',
                  severityNumber: 13,
                  body: { stringValue: 'clone lento' },
                  attributes: [{ key: 'ia.execution.id', value: { stringValue: 'exec-1' } }],
                },
              ],
            },
          ],
        },
      ],
    })

    expect(records[0]).toMatchObject({ kind: 'log', name: 'clone lento', level: 'warn' })
    expect(collector.received).toEqual([])
  })
})

describe('parseOtlpHeaders', () => {
  it('lee clave=valor separados por coma, con los valores url-encoded', () => {
    expect(parseOtlpHeaders(' a=1 , b=x%20y,,roto')).toEqual({ a: '1', b: 'x y' })
    expect(parseOtlpHeaders(undefined)).toEqual({})
  })
})
