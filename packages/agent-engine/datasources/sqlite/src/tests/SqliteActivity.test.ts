import {
  Agent,
  createEvent,
  deriveEvent,
  Engine,
  EventBus,
  type ExecutionRecord,
  FunctionAction,
  Pipeline,
  ProviderRegistry,
  StaticPipelineSource,
  scopeExecutionKey,
} from '@ia-flow/agent-engine'
import type { TraceRecord } from '@ia-flow/telemetry'
import { describe, expect, it } from 'vitest'
import { openNodeSqlite } from '../node.js'
import { SqliteActivityReader } from '../SqliteActivityReader.js'
import type { SqliteDatabase } from '../SqliteDatabase.js'
import { SqliteDispatchJournal } from '../SqliteDispatchJournal.js'
import { SqliteExecutionRepository } from '../SqliteExecutionRepository.js'
import { SqliteExecutionStore } from '../SqliteExecutionStore.js'
import { SqliteTraceJournal } from '../SqliteTraceJournal.js'

const REF = 'la-haus/eks#7'
const SCOPE = { projectId: 'p1', issue: REF, deliveryId: 'd-1' }

function setup(options: Partial<ConstructorParameters<typeof SqliteDispatchJournal>[0]> = {}) {
  const db: SqliteDatabase = openNodeSqlite(':memory:')
  const events = new SqliteDispatchJournal({ database: db, ...options })
  const written: TraceRecord[] = []
  const traces = new SqliteTraceJournal({ database: db, onWrite: (record) => written.push(record) })
  const repository = new SqliteExecutionRepository({ database: db })
  const reader = new SqliteActivityReader(db)
  return { db, events, traces, written, repository, reader }
}

const span = (overrides: Partial<TraceRecord> = {}): TraceRecord => ({
  kind: 'span',
  phase: 'end',
  name: 'chat claude',
  status: 'ok',
  startTime: '2026-09-29T10:00:00.000Z',
  endTime: '2026-09-29T10:00:01.000Z',
  durationMs: 1000,
  traceId: 't1',
  spanId: 's1',
  parentSpanId: 's0',
  executionId: 'exec-1',
  origin: 'runner',
  attributes: {},
  ...overrides,
})

const execution = (overrides: Partial<ExecutionRecord> = {}): ExecutionRecord => ({
  id: 'exec-1',
  key: JSON.stringify([
    ['deliveryId', 'd-1'],
    ['issue', REF],
    ['projectId', 'p1'],
  ]),
  pipelineId: 'build',
  status: 'done',
  startedAt: '2026-09-29T10:00:00.000Z',
  waitedMs: 0,
  closedAt: '2026-09-29T10:05:00.000Z',
  ...overrides,
})

describe('SqliteDispatchJournal + SqliteActivityReader: events', () => {
  it('records what the engine decided for each event, and reads it back by task', async () => {
    const { events, reader } = setup({
      summarize: (event) => ({ action: String(event.payload.action ?? '') }),
      traceId: () => 'trace-1',
    })
    const ran: string[] = []
    const engine = new Engine({
      bus: new EventBus(),
      pipelines: new StaticPipelineSource(
        [
          new Pipeline({
            id: 'label',
            on: ['github.issues'],
            do: [new FunctionAction({ fn: () => ran.push('label') })],
          }),
          new Pipeline({ id: 'off', on: ['github.issues'], do: [], enabled: false }),
        ],
        { id: 'p1' },
      ),
      dispatchJournal: events,
    })
    const event = createEvent('github.issues', { action: 'labeled' }, { scope: SCOPE })

    expect(await engine.dispatch(event)).toBe('dispatched')

    const [logged] = reader.eventsForTask(REF)
    expect(logged).toMatchObject({
      id: event.id,
      type: 'github.issues',
      depth: 0,
      projectId: 'p1',
      taskRef: REF,
      deliveryId: 'd-1',
      summary: { action: 'labeled' },
      outcome: 'dispatched',
      traceId: 'trace-1',
      decisions: [
        { pipelineId: 'label', sourceId: 'p1', verdict: 'ran' },
        { pipelineId: 'off', sourceId: 'p1', verdict: 'mismatch', reason: 'deshabilitada' },
      ],
    })
    expect(logged?.error).toBeUndefined()
    // Un evento raíz no guarda su payload por default (el de un webhook es grande).
    expect(reader.event(event.id)?.payload).toBeUndefined()
    expect(reader.event(event.id)?.scope).toEqual(SCOPE)
  })

  it('keeps the payload of derived events, and links them to their parent and delivery', () => {
    const { events, reader } = setup()
    const root = createEvent('github.issues', { big: true }, { scope: SCOPE })
    const child = deriveEvent(root, 'build.requested', { reason: 'x' })
    events.record({ event: root, decisions: [], outcome: 'skipped' })
    events.record({ event: child, decisions: [], outcome: 'dispatched', executionId: 'exec-9' })

    expect(reader.event(child.id)).toMatchObject({
      parentId: root.id,
      payload: { reason: 'x' },
      scope: SCOPE,
      executionId: 'exec-9',
    })
    expect(reader.eventsForDelivery('d-1').map((entry) => entry.id)).toEqual([root.id, child.id])
    expect(reader.event('nope')).toBeUndefined()
  })

  it('appends events the app ignores, with the reason in the summary', () => {
    const { events, reader } = setup({ summarize: () => ({ sender: 'bot' }) })
    const event = createEvent('github.push', {}, { scope: SCOPE })
    events.append({ event, reason: 'repo sin proyecto' })

    expect(reader.event(event.id)).toMatchObject({
      outcome: 'ignored',
      decisions: [],
      summary: { sender: 'bot', ignored_reason: 'repo sin proyecto' },
    })
  })

  it('a second record for the same event id keeps the latest decision', () => {
    const { events, reader } = setup()
    const event = createEvent('x', {}, { scope: SCOPE })
    events.record({ event, decisions: [], outcome: 'error', error: 'boom' })
    events.record({ event, decisions: [], outcome: 'dispatched', executionId: 'exec-1' })

    expect(reader.eventsForTask(REF)).toHaveLength(1)
    expect(reader.event(event.id)).toMatchObject({ outcome: 'dispatched', executionId: 'exec-1' })
    expect(reader.event(event.id)?.error).toBeUndefined()
  })

  it('finds the last event of a task, optionally by outcome, and the recent ones', () => {
    const { events, reader } = setup()
    const at = (occurredAt: string, type: string) =>
      createEvent(type, {}, { scope: SCOPE, occurredAt })
    const first = at('2026-09-29T10:00:00.000Z', 'a')
    const second = at('2026-09-29T11:00:00.000Z', 'b')
    const other = createEvent(
      'c',
      {},
      { scope: { issue: 'o/r#1' }, occurredAt: '2026-09-29T12:00:00.000Z' },
    )
    events.record({ event: first, decisions: [], outcome: 'dispatched' })
    events.record({ event: second, decisions: [], outcome: 'skipped' })
    events.record({ event: other, decisions: [], outcome: 'dispatched' })

    expect(reader.lastEventForTask(REF)?.id).toBe(second.id)
    expect(reader.lastEventForTask(REF, { outcomes: ['dispatched', 'injected'] })?.id).toBe(
      first.id,
    )
    expect(reader.lastEventForTask('nadie')).toBeUndefined()
    expect(reader.eventsForTask(REF, 1).map((entry) => entry.id)).toEqual([second.id])
    expect(reader.recentEvents({ limit: 2 }).map((entry) => entry.id)).toEqual([
      other.id,
      second.id,
    ])
    expect(
      reader.recentEvents({ since: '2026-09-29T10:30:00.000Z' }).map((entry) => entry.id),
    ).toEqual([other.id, second.id])
  })

  it('filters and counts events by type prefix: what came in through each ingress', () => {
    const { events, reader } = setup()
    const at = (occurredAt: string, type: string) => createEvent(type, {}, { occurredAt })
    const push = at('2026-09-29T10:00:00.000Z', 'github.push')
    const item = at('2026-09-29T11:00:00.000Z', 'github.projects_v2_item')
    const slack = at('2026-09-29T12:00:00.000Z', 'slack.message')
    const derived = at('2026-09-29T13:00:00.000Z', 'issue.status_changed')
    for (const event of [push, item, slack, derived]) {
      events.record({ event, decisions: [], outcome: 'dispatched' })
    }
    expect(reader.recentEvents({ typePrefix: 'github.' }).map((e) => e.id)).toEqual([
      item.id,
      push.id,
    ])
    expect(reader.countEvents({ typePrefix: 'github.' })).toEqual({
      count: 2,
      lastAt: '2026-09-29T11:00:00.000Z',
    })
    expect(
      reader.countEvents({ typePrefix: 'github.', since: '2026-09-29T10:30:00.000Z' }).count,
    ).toBe(1)
    expect(reader.countEvents({ typePrefix: 'nada.' })).toEqual({ count: 0 })
  })

  it('stores a numeric issue as text', () => {
    const { events, reader } = setup()
    events.record({
      event: createEvent('x', {}, { scope: { issue: 42 } }),
      decisions: [],
      outcome: 'skipped',
    })
    expect(reader.eventsForTask('42')).toHaveLength(1)
  })
})

describe('SqliteTraceJournal + SqliteActivityReader: traces', () => {
  it('writes each record at once, in order, and tells whoever listens', () => {
    const { traces, written, reader } = setup()
    const start = span({
      phase: 'start',
      status: undefined,
      endTime: undefined,
      durationMs: undefined,
    })
    const log: TraceRecord = {
      kind: 'log',
      name: 'abre',
      scope: 'agent-engine.execution',
      level: 'info',
      startTime: '2026-09-29T10:00:00.500Z',
      traceId: 't1',
      spanId: 's1',
      executionId: 'exec-1',
      origin: 'runner',
      attributes: { 'ia.execution.id': 'exec-1' },
    }
    traces.write(start)
    traces.write(log)
    traces.write(span({ statusMessage: 'ok!', attributes: { tags: ['a', 'b'], n: 1 } }))
    traces.write(span({ executionId: 'exec-2' }))

    expect(written).toHaveLength(4)
    const trace = reader.trace('exec-1')
    expect(trace.map((entry) => [entry.kind, entry.phase ?? '-'])).toEqual([
      ['span', 'start'],
      ['log', '-'],
      ['span', 'end'],
    ])
    expect(trace[0]).toEqual({ seq: 1, ...start })
    expect(trace[1]).toEqual({ seq: 2, ...log })
    expect(trace[2]?.attributes).toEqual({ tags: ['a', 'b'], n: 1 })
    expect(trace[2]?.statusMessage).toBe('ok!')
    expect(reader.trace('exec-1', { afterSeq: 1, limit: 1 }).map((entry) => entry.seq)).toEqual([2])
  })

  it('a listener that throws does not break the write', () => {
    const db = openNodeSqlite(':memory:')
    const traces = new SqliteTraceJournal({
      database: db,
      onWrite: () => {
        throw new Error('sse caído')
      },
    })
    expect(() => traces.write(span())).not.toThrow()
    expect(new SqliteActivityReader(db).trace('exec-1')).toHaveLength(1)
  })

  it('sums the token usage of the model requests of an execution', () => {
    const { traces, reader } = setup()
    traces.write(
      span({
        attributes: {
          'gen_ai.usage.input_tokens': 100,
          'gen_ai.usage.output_tokens': 10,
          'gen_ai.usage.cache_read_input_tokens': 1000,
        },
      }),
    )
    traces.write(
      span({ attributes: { 'gen_ai.usage.input_tokens': 5, 'gen_ai.usage.output_tokens': 1 } }),
    )
    // Un span que empieza no cuenta: sus atributos llegan al terminar.
    traces.write(span({ phase: 'start', attributes: { 'gen_ai.usage.input_tokens': 999 } }))

    expect(reader.usage('exec-1')).toEqual({
      inputTokens: 105,
      outputTokens: 11,
      cacheReadTokens: 1000,
    })
    expect(reader.usage('nada')).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 })
  })

  it('reads how the last agent ended: exit, or who failed and why', () => {
    const { traces, reader } = setup()
    const agent = (attributes: Record<string, string>, overrides: Partial<TraceRecord> = {}) =>
      span({
        name: `agent ${attributes['ia.agent.id']}`,
        attributes: { 'ia.step.kind': 'agent', ...attributes },
        ...overrides,
      })
    traces.write(agent({ 'ia.agent.id': 'refiner', 'ia.agent.exit': 'done' }))
    // Una tool del agente también hereda `ia.agent.id`: no es el agente.
    traces.write(span({ name: 'tool fs_read', attributes: { 'ia.agent.id': 'implementer' } }))
    expect(reader.agentOutcome('exec-1')).toMatchObject({
      agentId: 'refiner',
      exit: 'done',
      status: 'ok',
    })

    traces.write(
      agent(
        { 'ia.agent.id': 'implementer', 'ia.step.error_handled': 'onError' },
        {
          status: 'error',
          statusMessage: 'Agent(implementer): el agente declaró que falló: falta el token',
        },
      ),
    )
    expect(reader.agentOutcome('exec-1')).toMatchObject({
      agentId: 'implementer',
      status: 'error',
      failure: { by: 'agent', message: 'falta el token' },
      errorHandledBy: 'onError',
    })

    traces.write(
      agent({ 'ia.agent.id': 'reviewer' }, { status: 'error', statusMessage: 'ECONNRESET' }),
    )
    expect(reader.agentOutcome('exec-1')?.failure).toEqual({
      by: 'runtime',
      message: 'ECONNRESET',
    })
    expect(reader.agentOutcome('otra')).toBeUndefined()
  })
})

describe('SqliteActivityReader: executions and prune', () => {
  it('lists executions by task and status, with the task parsed from the key', () => {
    const { repository, reader } = setup()
    repository.save(execution())
    repository.save(
      execution({
        id: 'exec-2',
        status: 'paused',
        startedAt: '2026-09-29T11:00:00.000Z',
        pause: { pauseId: 'wait-ci', branches: [], expiresAt: 123 },
      }),
    )
    repository.save(
      execution({
        id: 'exec-3',
        key: JSON.stringify([['issue', 'o/r#1']]),
        startedAt: '2026-09-29T12:00:00.000Z',
      }),
    )
    // Una key propia de la app, que no es JSON: no rompe la consulta.
    repository.save(execution({ id: 'exec-4', key: 'custom:key', status: 'failed' }))

    expect(reader.executions({ taskRef: REF }).map((entry) => entry.id)).toEqual([
      'exec-2',
      'exec-1',
    ])
    const [paused] = reader.executions({ taskRef: REF, statuses: ['paused', 'running'] })
    expect(paused).toMatchObject({
      id: 'exec-2',
      taskRef: REF,
      projectId: 'p1',
      pipelineId: 'build',
      status: 'paused',
      pause: { pauseId: 'wait-ci' },
    })
    expect(reader.executions({ limit: 2 }).map((entry) => entry.id)).toEqual(['exec-3', 'exec-2'])
    const custom = reader.executions({ statuses: ['failed'] })[0]
    expect(custom?.id).toBe('exec-4')
    expect(custom?.taskRef).toBeUndefined()
  })

  it('finds executions whose issue is a number, keyed by the engine', () => {
    const { repository, reader } = setup()
    const key = scopeExecutionKey(createEvent('x', {}, { scope: { issue: 7 } })) as string
    repository.save(execution({ key }))
    expect(reader.executions({ taskRef: '7' })).toHaveLength(1)
  })

  it('prunes old events, traces and closed executions — never a live one', () => {
    const { db, events, traces, repository, reader } = setup()
    const old = '2026-01-01T00:00:00.000Z'
    const cutoff = '2026-06-01T00:00:00.000Z'
    events.record({
      event: createEvent('old', {}, { scope: SCOPE, occurredAt: old }),
      decisions: [],
      outcome: 'skipped',
    })
    events.record({
      event: createEvent('new', {}, { scope: SCOPE }),
      decisions: [],
      outcome: 'skipped',
    })
    repository.save(execution({ id: 'closed', startedAt: old, closedAt: old }))
    repository.delivered('closed', createEvent('c', {}))
    repository.save(
      execution({
        id: 'live',
        key: '["live"]',
        status: 'paused',
        startedAt: old,
        closedAt: undefined,
        pause: { pauseId: 'p', branches: [] },
      }),
    )
    traces.write(span({ executionId: 'closed', startTime: old }))
    traces.write(span({ executionId: 'live', startTime: old }))
    traces.write(span({ executionId: 'closed' }))

    expect(reader.prune(cutoff)).toEqual({ events: 1, traces: 1, executions: 1 })
    expect(reader.recentEvents().map((entry) => entry.type)).toEqual(['new'])
    expect(reader.trace('live')).toHaveLength(1)
    expect(reader.trace('closed')).toHaveLength(1)
    expect(reader.executions().map((entry) => entry.id)).toEqual(['live'])
    const inbox = db.prepare('SELECT COUNT(*) AS n FROM execution_inbox').get() as { n: number }
    expect(inbox.n).toBe(0)
  })
})

describe('with the engine and a real store', () => {
  it('stamps the execution an agent run opened', async () => {
    const db = openNodeSqlite(':memory:')
    const store = new SqliteExecutionStore({ database: db })
    const events = new SqliteDispatchJournal({ database: db })
    const reader = new SqliteActivityReader(db)
    const agent = new Agent(
      { id: 'implementer', provider: 'done', prompt: 'p' },
      new ProviderRegistry().register({ id: 'done', run: async () => ({ outcome: 'success' }) }),
    )
    const engine = new Engine({
      bus: new EventBus(),
      pipelines: new StaticPipelineSource([
        new Pipeline({ id: 'build', on: ['build'], do: [agent] }),
      ]),
      executions: store,
      dispatchJournal: events,
    })
    const event = createEvent('build', {}, { scope: { projectId: 'p1', issue: REF } })

    await engine.dispatch(event)

    const [run] = reader.executions({ taskRef: REF })
    expect(run).toMatchObject({
      pipelineId: 'build',
      status: 'done',
      taskRef: REF,
      projectId: 'p1',
    })
    expect(reader.event(event.id)?.executionId).toBe(run?.id)
  })
})
