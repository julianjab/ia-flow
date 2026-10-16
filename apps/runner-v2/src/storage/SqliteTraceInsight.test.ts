import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'
import type { ExecutionRecord } from '@ia-flow/agent-engine'
import {
  SqliteExecutionRepository,
  SqliteTraceJournal,
} from '@ia-flow/agent-engine-datasource-sqlite'
import type { TraceRecord } from '@ia-flow/telemetry'
import { excerptAround, SqliteTraceInsight } from './SqliteTraceInsight.js'

const keyOf = (ref: string, project = 'p') =>
  JSON.stringify([
    ['issue', ref],
    ['projectId', project],
  ])

let spanSeq = 0
const record = (executionId: string, patch: Partial<TraceRecord>): TraceRecord => ({
  kind: 'log',
  name: 'log',
  level: 'info',
  startTime: '2026-10-16T10:00:00.000Z',
  traceId: 't',
  spanId: `s${spanSeq++}`,
  executionId,
  origin: 'runner',
  attributes: { 'ia.execution.id': executionId },
  ...patch,
})

function setup() {
  const database = new Database(':memory:')
  const repository = new SqliteExecutionRepository({ database })
  const traces = new SqliteTraceJournal({ database })
  const execution = (patch: Partial<ExecutionRecord> & { id: string }) =>
    repository.save({
      key: keyOf('o/r#1'),
      pipelineId: 'build',
      status: 'done',
      startedAt: '2026-10-16T10:00:00.000Z',
      waitedMs: 0,
      closedAt: '2026-10-16T10:30:00.000Z',
      ...patch,
    })
  return {
    insight: new SqliteTraceInsight(database),
    execution,
    write: (executionId: string, patch: Partial<TraceRecord>) =>
      traces.write(record(executionId, patch)),
  }
}

describe('SqliteTraceInsight.search', () => {
  it('finds a text across every execution, newest first, with how many matched and samples', () => {
    const { insight, execution, write } = setup()
    execution({ id: 'e1', startedAt: '2026-10-15T10:00:00.000Z' })
    execution({ id: 'e2', key: keyOf('o/r#2'), pipelineId: 'review', status: 'failed' })
    write('e1', { name: 'chat', attributes: { 'gen_ai.response.stop': 'pause_turn' } })
    write('e1', { name: 'otra cosa' })
    write('e1', { name: 'chat', attributes: { 'gen_ai.response.stop': 'PAUSE_TURN' } })
    write('e2', { name: 'tool.call' })
    write('e2', {
      name: 'chat',
      attributes: { 'ia.agent.id': 'reviewer', 'gen_ai.response.stop': 'pause_turn' },
    })

    const found = insight.search({ text: 'Pause_Turn', limit: 10, samples: 3 })

    expect(found.truncated).toBe(false)
    expect(found.executions).toEqual([
      {
        execution_id: 'e2',
        task_ref: 'o/r#2',
        project_id: 'p',
        pipeline_id: 'review',
        status: 'failed',
        started_at: '2026-10-16T10:00:00.000Z',
        agents: ['reviewer'],
        matches: 1,
        samples: [
          {
            index: 1,
            name: 'chat',
            at: '2026-10-16T10:00:00.000Z',
            agent: 'reviewer',
            excerpt: expect.stringContaining('pause_turn'),
          },
        ],
      },
      expect.objectContaining({
        execution_id: 'e1',
        task_ref: 'o/r#1',
        agents: [],
        matches: 2,
        samples: [
          expect.objectContaining({ index: 0, name: 'chat' }),
          expect.objectContaining({ index: 2, name: 'chat' }),
        ],
      }),
    ])
  })

  it('filters by time, agent, pipeline, status, task and project', () => {
    const { insight, execution, write } = setup()
    execution({ id: 'e1' })
    execution({
      id: 'e2',
      key: keyOf('o/r#2', 'q'),
      pipelineId: 'review',
      status: 'running',
      startedAt: '2026-10-16T11:00:00.000Z',
    })
    write('e1', { name: 'memory write', startTime: '2026-10-10T00:00:00.000Z' })
    write('e2', {
      name: 'memory write',
      startTime: '2026-10-16T09:00:00.000Z',
      attributes: { 'ia.agent.id': 'e2e-visual-qa' },
    })
    const ids = (query: Parameters<SqliteTraceInsight['search']>[0]) =>
      insight.search(query).executions.map((hit) => hit.execution_id)
    const base = { text: 'memory', limit: 10, samples: 1 }

    expect(ids(base)).toEqual(['e2', 'e1'])
    expect(ids({ ...base, since: '2026-10-15T00:00:00.000Z' })).toEqual(['e2'])
    expect(ids({ ...base, until: '2026-10-15T00:00:00.000Z' })).toEqual(['e1'])
    expect(ids({ ...base, agentId: 'e2e-visual-qa' })).toEqual(['e2'])
    expect(ids({ ...base, pipelineId: 'build' })).toEqual(['e1'])
    expect(ids({ ...base, status: 'running' })).toEqual(['e2'])
    expect(ids({ ...base, taskRef: 'o/r#1' })).toEqual(['e1'])
    expect(ids({ ...base, projectId: 'q' })).toEqual(['e2'])
  })

  it('searches the error message too, and says when there are more than the limit', () => {
    const { insight, execution, write } = setup()
    for (const id of ['e1', 'e2', 'e3']) {
      execution({ id, key: keyOf(`o/r#${id}`), startedAt: `2026-10-16T10:0${id[1]}:00.000Z` })
      write(id, { kind: 'span', name: 'agent x', status: 'error', statusMessage: 'ENOSPC: disco' })
    }
    const found = insight.search({ text: 'enospc', limit: 2, samples: 1 })
    expect(found.truncated).toBe(true)
    expect(found.executions.map((hit) => hit.execution_id)).toEqual(['e3', 'e2'])
  })
})

describe('SqliteTraceInsight: last step and each agent of an execution', () => {
  it('the last step of each execution is its newest start or end', () => {
    const { insight, execution, write } = setup()
    execution({ id: 'e1', status: 'running' })
    write('e1', { startTime: '2026-10-16T10:00:00.000Z' })
    write('e1', {
      kind: 'span',
      phase: 'end',
      startTime: '2026-10-16T10:01:00.000Z',
      endTime: '2026-10-16T10:05:00.000Z',
    })
    write('e1', { startTime: '2026-10-16T10:03:00.000Z' })
    expect(insight.lastStepAt(['e1', 'missing'])).toEqual(
      new Map([['e1', '2026-10-16T10:05:00.000Z']]),
    )
    expect(insight.lastStepAt([])).toEqual(new Map())
  })

  it('a parallel group: one agent still running, the other finished with its exit', () => {
    const { insight, execution, write } = setup()
    execution({ id: 'e1', pipelineId: 'review', status: 'running' })
    const agentSpan = (agent: string, phase: 'start' | 'end', patch: Partial<TraceRecord>) =>
      write('e1', {
        kind: 'span',
        phase,
        name: `agent ${agent}`,
        spanId: `span-${agent}`,
        ...patch,
        attributes: { 'ia.agent.id': agent, 'ia.step.kind': 'agent', ...patch.attributes },
      })
    agentSpan('reviewer', 'start', { startTime: '2026-10-16T10:00:00.000Z' })
    agentSpan('e2e-visual-qa', 'start', { startTime: '2026-10-16T10:00:01.000Z' })
    write('e1', {
      name: 'tool.call',
      startTime: '2026-10-16T10:07:00.000Z',
      attributes: { 'ia.agent.id': 'e2e-visual-qa', 'gen_ai.tool.name': 'Bash' },
    })
    agentSpan('reviewer', 'end', {
      startTime: '2026-10-16T10:00:00.000Z',
      endTime: '2026-10-16T10:04:00.000Z',
      status: 'ok',
      attributes: { 'ia.agent.exit': 'approve', 'ia.agent.summary': 'Todo bien' },
    })

    expect(insight.agentRuns('e1')).toEqual([
      {
        agent_id: 'reviewer',
        started_at: '2026-10-16T10:00:00.000Z',
        ended_at: '2026-10-16T10:04:00.000Z',
        status: 'ok',
        exit: 'approve',
        summary: 'Todo bien',
        last_step_at: '2026-10-16T10:04:00.000Z',
      },
      {
        agent_id: 'e2e-visual-qa',
        started_at: '2026-10-16T10:00:01.000Z',
        last_step_at: '2026-10-16T10:07:00.000Z',
      },
    ])
  })

  it('a failed agent says why; only the end of a remote span is enough', () => {
    const { insight, execution, write } = setup()
    execution({ id: 'e1', status: 'failed' })
    write('e1', {
      kind: 'span',
      phase: 'end',
      name: 'agent implementer',
      startTime: '2026-10-16T10:00:00.000Z',
      endTime: '2026-10-16T10:02:00.000Z',
      status: 'error',
      statusMessage: 'se quedó sin maxToolRounds',
      attributes: { 'ia.agent.id': 'implementer', 'ia.step.kind': 'agent' },
    })
    expect(insight.agentRuns('e1')).toEqual([
      expect.objectContaining({
        agent_id: 'implementer',
        status: 'error',
        failure: 'se quedó sin maxToolRounds',
        ended_at: '2026-10-16T10:02:00.000Z',
      }),
    ])
  })
})

describe('excerptAround', () => {
  it('cuts around the match and marks what it left out', () => {
    const text = `${'a'.repeat(200)}NEEDLE${'b'.repeat(200)}`
    const excerpt = excerptAround(text, 'needle')
    expect(excerpt.startsWith('…')).toBe(true)
    expect(excerpt.endsWith('…')).toBe(true)
    expect(excerpt).toContain('NEEDLE')
    expect(excerpt.length).toBeLessThan(200)
  })
})
