import { describe, expect, it } from 'bun:test'
import { agentLanes, secondsSince, withLiveness } from './liveness.js'
import type { AgentRun, TraceInsight } from './TraceInsight.js'

const NOW = new Date('2026-10-16T10:10:00.000Z')

const reviewer: AgentRun = {
  agent_id: 'reviewer',
  started_at: '2026-10-16T10:00:00.000Z',
  ended_at: '2026-10-16T10:04:00.000Z',
  status: 'ok',
  exit: 'approve',
  summary: 'Todo bien',
  last_step_at: '2026-10-16T10:04:00.000Z',
}
const e2e: AgentRun = {
  agent_id: 'e2e-visual-qa',
  started_at: '2026-10-16T10:00:01.000Z',
  last_step_at: '2026-10-16T10:07:00.000Z',
}

describe('secondsSince', () => {
  it('whole seconds, never negative; without a date, nothing', () => {
    expect(secondsSince('2026-10-16T10:07:00.000Z', NOW)).toBe(180)
    expect(secondsSince('2026-10-16T11:00:00.000Z', NOW)).toBe(0)
    expect(secondsSince(undefined, NOW)).toBeUndefined()
    expect(secondsSince('ayer', NOW)).toBeUndefined()
  })
})

describe('agentLanes', () => {
  it('each agent of a parallel group with its own state; the running one, how long idle', () => {
    expect(agentLanes([reviewer, e2e], 'running', NOW)).toEqual([
      { ...reviewer, state: 'done' },
      { ...e2e, state: 'running', idle_seconds: 180 },
    ])
  })

  it('failed, waiting, interrupted, and unfinished when the execution already closed', () => {
    const lanes = agentLanes(
      [
        { ...reviewer, status: 'error', failure: 'x' },
        { ...reviewer, agent_id: 'w', waiting: 'check_suite' },
        { ...reviewer, agent_id: 'i', interrupted_by: 'human' },
        e2e,
      ],
      'failed',
      NOW,
    )
    expect(lanes.map((lane) => lane.state)).toEqual([
      'failed',
      'waiting',
      'interrupted',
      'unfinished',
    ])
    expect(lanes[3]?.idle_seconds).toBeUndefined()
  })
})

describe('withLiveness', () => {
  const traces = {
    lastStepAt: (ids: readonly string[]) =>
      new Map(ids.filter((id) => id === 'live').map((id) => [id, '2026-10-16T10:09:00.000Z'])),
    agentRuns: (id: string) => (id === 'solo' ? [reviewer] : [reviewer, e2e]),
  } as unknown as TraceInsight

  it('a live execution says its last step and its agents', () => {
    const [live] = withLiveness([{ id: 'live', status: 'running' as const }], traces, NOW)
    expect(live).toMatchObject({
      last_step_at: '2026-10-16T10:09:00.000Z',
      idle_seconds: 60,
      agents: [{ agent_id: 'reviewer' }, { agent_id: 'e2e-visual-qa', state: 'running' }],
    })
  })

  it('a closed one only brings its agents when asked and when more than one ran', () => {
    const executions = [
      { id: 'group', status: 'done' as const },
      { id: 'solo', status: 'done' as const },
      { id: 'old', status: 'done' as const },
    ]
    const out = withLiveness(executions, traces, NOW, (execution) => execution.id !== 'old')
    expect(out[0]?.agents?.map((lane) => lane.agent_id)).toEqual(['reviewer', 'e2e-visual-qa'])
    expect(out[0]?.last_step_at).toBeUndefined()
    expect(out[1]?.agents).toBeUndefined()
    expect(out[2]?.agents).toBeUndefined()
  })

  it('without trace insight, the executions as they are', () => {
    const executions = [{ id: 'live', status: 'running' as const }]
    expect(withLiveness(executions, undefined, NOW)).toEqual(executions)
  })
})
