import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'
import { createEvent, deriveEvent } from '@ia-flow/agent-engine'
import {
  SqliteActivityReader,
  SqliteDispatchJournal,
  SqliteExecutionRepository,
  SqliteTraceJournal,
} from '@ia-flow/agent-engine-datasource-sqlite'
import type { TraceRecord } from '@ia-flow/telemetry'
import { summarizeEvent } from './eventSummary.js'
import { SqliteActivity } from './SqliteActivity.js'

const KEY = JSON.stringify([
  ['issue', 'o/r#1'],
  ['projectId', 'p'],
])

const span = (patch: Partial<TraceRecord>): TraceRecord => ({
  kind: 'span',
  phase: 'end',
  name: 'span',
  startTime: '2026-09-29T11:00:00.000Z',
  endTime: '2026-09-29T11:00:01.000Z',
  traceId: 't1',
  spanId: `s${Math.random()}`,
  executionId: 'e1',
  origin: 'runner',
  status: 'ok',
  attributes: { 'ia.execution.id': 'e1' },
  ...patch,
})

function setup() {
  const database = new Database(':memory:')
  const repository = new SqliteExecutionRepository({ database })
  const events = new SqliteDispatchJournal({
    database,
    summarize: (event) => summarizeEvent(event, 140),
  })
  const traces = new SqliteTraceJournal({ database })
  const reader = new SqliteActivityReader(database)
  return {
    repository,
    events,
    traces,
    reader,
    activity: new SqliteActivity(reader),
  }
}

describe('SqliteActivity', () => {
  it('an execution comes back with its agent, how it failed and the tokens it spent', () => {
    const { repository, traces, activity } = setup()
    repository.save({
      id: 'e1',
      key: KEY,
      pipelineId: 'refine',
      status: 'done',
      startedAt: '2026-09-29T11:00:00.000Z',
      waitedMs: 0,
      closedAt: '2026-09-29T11:05:00.000Z',
    })
    traces.write(
      span({
        name: 'chat claude-opus',
        attributes: {
          'ia.execution.id': 'e1',
          'gen_ai.usage.input_tokens': 1_000,
          'gen_ai.usage.output_tokens': 200,
        },
      }),
    )
    traces.write(
      span({
        name: 'agent refiner',
        status: 'error',
        statusMessage: 'Agent(refiner): el agente declaró que falló: ¿Aplica a downgrades?',
        attributes: {
          'ia.execution.id': 'e1',
          'ia.agent.id': 'refiner',
          'ia.step.kind': 'agent',
          'ia.agent.exit': 'error',
        },
      }),
    )

    const [execution] = activity.executions({ taskRef: 'o/r#1' })
    expect(execution).toMatchObject({
      id: 'e1',
      key: KEY,
      task_ref: 'o/r#1',
      project_id: 'p',
      pipeline_id: 'refine',
      status: 'done',
      agent_id: 'refiner',
      usage: { input_tokens: 1_000, output_tokens: 200, cache_read_tokens: 0 },
      failure: { by: 'agent', message: '¿Aplica a downgrades?' },
    })
    expect(activity.trace('e1', 10).map((entry) => entry.name)).toEqual([
      'chat claude-opus',
      'agent refiner',
    ])
  })

  it('a settled execution summary is built once; a recently closed one is rebuilt (late host telemetry)', () => {
    let now = Date.parse('2026-09-29T11:06:00.000Z')
    const fresh = setup()
    const activity = new SqliteActivity(fresh.reader, () => now)
    fresh.repository.save({
      id: 'e1',
      key: KEY,
      pipelineId: 'build',
      status: 'done',
      startedAt: '2026-09-29T11:00:00.000Z',
      waitedMs: 0,
      closedAt: '2026-09-29T11:05:00.000Z',
    })
    const tokens = (n: number) =>
      span({
        name: 'chat',
        attributes: { 'ia.execution.id': 'e1', 'gen_ai.usage.output_tokens': n },
      })
    fresh.traces.write(tokens(100))
    const output = () => activity.executions({ taskRef: 'o/r#1' })[0]?.usage?.output_tokens

    // Cerrada hace un minuto: la telemetría del host todavía puede llegar.
    expect(output()).toBe(100)
    fresh.traces.write(tokens(50))
    expect(output()).toBe(150)

    // Cerrada hace más de cinco minutos: ya no cambia, y no se vuelve a recorrer su traza.
    now = Date.parse('2026-09-29T11:20:00.000Z')
    expect(output()).toBe(150)
    fresh.traces.write(tokens(999))
    expect(output()).toBe(150)
  })

  it('in batch: the last closed execution and the last event of each task, in one read', () => {
    const { repository, events, activity } = setup()
    const key = (ref: string) =>
      JSON.stringify([
        ['issue', ref],
        ['projectId', 'p'],
      ])
    const save = (
      id: string,
      ref: string,
      status: 'done' | 'failed' | 'running',
      startedAt: string,
    ) =>
      repository.save({
        id,
        key: key(ref),
        pipelineId: 'build',
        status,
        startedAt,
        waitedMs: 0,
        ...(status === 'running' ? {} : { closedAt: startedAt }),
      })
    save('a1', 'o/r#1', 'done', '2026-09-29T10:00:00.000Z')
    save('a2', 'o/r#1', 'failed', '2026-09-29T11:00:00.000Z')
    save('a3', 'o/r#1', 'running', '2026-09-29T12:00:00.000Z')
    save('b1', 'o/r#2', 'done', '2026-09-29T09:00:00.000Z')
    save('c1', 'o/r#3', 'done', '2026-09-29T09:00:00.000Z')
    const event = (ref: string, at: string) =>
      events.record({
        event: {
          ...createEvent('github.issue_comment', {}, { scope: { issue: ref } }),
          occurredAt: at,
        },
        decisions: [],
        outcome: 'dispatched',
      })
    event('o/r#1', '2026-09-29T10:00:00.000Z')
    event('o/r#1', '2026-09-29T13:00:00.000Z')
    event('o/r#2', '2026-09-29T08:00:00.000Z')

    const closed = activity.lastClosedByTask(['o/r#1', 'o/r#2', 'o/r#9'])
    expect([...closed.keys()].sort()).toEqual(['o/r#1', 'o/r#2'])
    expect(closed.get('o/r#1')).toMatchObject({ id: 'a2', status: 'failed' })
    // Lo mismo que la consulta de a una.
    expect(closed.get('o/r#1')?.id).toBe(
      activity.executions({
        taskRef: 'o/r#1',
        statuses: ['done', 'failed', 'superseded'],
        limit: 1,
      })[0]?.id,
    )
    const lastEvents = activity.lastEventAtByTask(['o/r#1', 'o/r#2', 'o/r#9'])
    expect(lastEvents.get('o/r#1')).toBe(activity.lastEventAt('o/r#1'))
    expect(lastEvents.get('o/r#2')).toBe(activity.lastEventAt('o/r#2'))
    expect(lastEvents.has('o/r#9')).toBe(false)
    expect(activity.lastEventAtByTask([]).size).toBe(0)
  })

  it('a failed run without an agent failure is a runtime failure with its close reason', () => {
    const { repository, activity } = setup()
    repository.save({
      id: 'e2',
      key: KEY,
      pipelineId: 'build',
      status: 'failed',
      startedAt: '2026-09-29T11:00:00.000Z',
      waitedMs: 0,
      closeReason: 'task budget exceeded',
    })
    expect(activity.executions({ taskRef: 'o/r#1' })[0]?.failure).toEqual({
      by: 'runtime',
      message: 'task budget exceeded',
    })
  })

  it('events keep what each pipeline decided; retry re-dispatches the last domain event', () => {
    const { events, activity } = setup()
    const raw = createEvent(
      'github.projects_v2_item',
      { action: 'edited' },
      { scope: { issue: 'o/r#1' } },
    )
    events.record({ event: raw, decisions: [], outcome: 'dispatched' })
    const derived = deriveEvent(
      raw,
      'projects_v2_item.edited',
      { fieldName: 'Working', author: 'julian' },
      {
        scope: { issue: 'o/r#1', projectId: 'p' },
      },
    )
    events.record({
      event: derived,
      decisions: [
        {
          pipelineId: 'build-reentry',
          sourceId: 'p',
          verdict: 'mismatch',
          reason: 'fieldName notIn […]',
        },
      ],
      outcome: 'skipped',
    })
    const comment = deriveEvent(
      raw,
      'issue_comment',
      { body: 'mirá esto' },
      { scope: { issue: 'o/r#1' } },
    )
    events.record({ event: comment, decisions: [], outcome: 'injected' })

    const entries = activity.eventsForTask('o/r#1', 10)
    const edited = entries.find((entry) => entry.id === derived.id)
    expect(edited).toMatchObject({
      parent_id: raw.id,
      summary: { field: 'Working', author: 'julian', issue: 'o/r#1' },
      decisions: [
        { pipeline_id: 'build-reentry', verdict: 'mismatch', reason: 'fieldName notIn […]' },
      ],
      outcome: 'skipped',
    })
    // El raw (profundidad 0) no se re-despacha y el `skipped` no cuenta: el último útil es el comentario.
    expect(activity.lastDispatchedEvent('o/r#1')).toMatchObject({
      id: comment.id,
      type: 'issue_comment',
      payload: { body: 'mirá esto' },
    })
    expect(activity.lastEventAt('o/r#1')).toBeDefined()
  })
})
