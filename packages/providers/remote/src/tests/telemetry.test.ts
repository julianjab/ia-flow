import type { Provider } from '@ia-flow/agent-engine'
import { withInheritedAttributes, withSpan } from '@ia-flow/telemetry'
import { context, trace } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { HostClient } from '../HostClient.js'
import type { HostTask } from '../protocol.js'
import type { TelemetrySignal } from '../RemoteHub.js'
import {
  callTool,
  makeHost,
  makeHub,
  RUNNER,
  runContext,
  TOKEN,
  tool,
  until,
  wire,
} from './fixtures.js'

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

const hosts: HostClient[] = []
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.stop()))
})

const span = (name: string) => spans.getFinishedSpans().find((s) => s.name === name)

describe('la traza de una corrida remota', () => {
  it('lo que el host corre cuelga del span del agente, con los atributos de la ejecución', async () => {
    const { hub, registry } = makeHub()
    const seen: HostTask[] = []
    const host = makeHost(hub, async (task, runner, signal) => {
      seen.push(task)
      // Lo que hace el host (el worktree, la sesión) se traza como en el runner.
      await withSpan('workspace.prepare', {}, async () => {})
      await callTool(hub, `${runner.base}${task.endpoints.mcp}`, 'submit_done')
      if (!signal.aborted) {
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
      }
      return undefined
    })
    hosts.push(host)
    host.start()
    await until(() => registry.resolve('remote:laptop') !== undefined)

    await withInheritedAttributes(
      { 'ia.execution.id': 'exec-1', 'ia.issue': 'la-haus/eks#7' },
      () =>
        withSpan('agent implementer', {}, () =>
          (registry.resolve('remote:laptop') as Provider).run(
            runContext({ tools: [tool('submit_done', () => 'ok', { terminal: true })] }),
          ),
        ),
    )
    await until(() => span('host.run implementer') !== undefined)

    const agent = span('agent implementer')
    const run = span('host.run implementer')
    const workspace = span('workspace.prepare')
    expect(seen[0]?.trace).toMatchObject({
      attributes: { 'ia.execution.id': 'exec-1', 'ia.issue': 'la-haus/eks#7' },
    })
    expect(run?.spanContext().traceId).toBe(agent?.spanContext().traceId)
    expect(run?.parentSpanContext?.spanId).toBe(agent?.spanContext().spanId)
    expect(run?.attributes).toMatchObject({
      'ia.execution.id': 'exec-1',
      'ia.host.name': 'laptop',
    })
    expect(workspace?.parentSpanContext?.spanId).toBe(run?.spanContext().spanId)
    expect(workspace?.attributes).toMatchObject({ 'ia.execution.id': 'exec-1' })
  })
})

describe('/v1/hosts/telemetry', () => {
  const post = (
    hub: Parameters<typeof wire>[0],
    signal: string,
    init: { token?: string; type?: string; body?: string } = {},
  ) =>
    wire(hub)(`${RUNNER}/v1/hosts/telemetry/${signal}`, {
      method: 'POST',
      headers: {
        'content-type': init.type ?? 'application/json',
        ...(init.token === '' ? {} : { authorization: `Bearer ${init.token ?? TOKEN}` }),
      },
      body: init.body ?? JSON.stringify({ resourceSpans: [] }),
    })

  it('entrega al runner lo que el host exporta, ya parseado', async () => {
    const got: Array<[TelemetrySignal, unknown]> = []
    const { hub } = makeHub({ onTelemetry: (signal, payload) => void got.push([signal, payload]) })

    const traces = await post(hub, 'traces')
    const logs = await post(hub, 'logs', { body: JSON.stringify({ resourceLogs: [] }) })

    expect([traces.status, logs.status]).toEqual([200, 200])
    expect(got).toEqual([
      ['traces', { resourceSpans: [] }],
      ['logs', { resourceLogs: [] }],
    ])
  })

  it('pide el token de hosts, sólo JSON, y no existe si el runner no lo recibe', async () => {
    const { hub } = makeHub({ onTelemetry: () => {} })
    expect((await post(hub, 'traces', { token: '' })).status).toBe(401)
    expect((await post(hub, 'traces', { type: 'application/x-protobuf' })).status).toBe(415)
    expect((await post(hub, 'metrics')).status).toBe(404)
    expect((await post(makeHub().hub, 'traces')).status).toBe(404)
  })
})
