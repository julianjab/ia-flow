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
import { summarizeEvent } from '../inbox/eventSummary.js'
import { SqliteActivity } from '../inbox/SqliteActivity.js'

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
  return {
    repository,
    events,
    traces,
    activity: new SqliteActivity(new SqliteActivityReader(database)),
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
