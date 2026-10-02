import { describe, expect, it } from 'bun:test'
import type { ExecutionSummary } from '@ia-flow/shared'
import type { BoardCard, TaskActivity } from './classify.js'
import { buildTaskFacts, liveFacts, runFacts, unlocksOf } from './taskFacts.js'

const now = new Date('2026-09-29T12:00:00Z')
const card = (patch: Partial<BoardCard> = {}): BoardCard => ({
  ref: 'o/r#1',
  projectId: 'p',
  title: 't',
  url: 'u',
  status: 'Build',
  labels: ['blocked'],
  updatedAt: '2026-09-29T08:00:00Z',
  blockedBy: [],
  ...patch,
})
const run = (patch: Partial<ExecutionSummary> = {}): ExecutionSummary => ({
  id: 'e',
  pipeline_id: 'refine',
  status: 'done',
  started_at: '2026-09-29T09:00:00Z',
  ...patch,
})

describe('runFacts / liveFacts', () => {
  it('keep only what the run says; the summary falls back to the failure message', () => {
    expect(runFacts(undefined)).toEqual({})
    expect(
      runFacts(run({ exit: 'prerequisite', agent_id: 'refiner', summary: 'falta #1578' })),
    ).toEqual({ exit: 'prerequisite', status: 'done', agent: 'refiner', summary: 'falta #1578' })
    expect(runFacts(run({ failure: { by: 'agent', message: '¿90 días?' } }))).toMatchObject({
      failure_by: 'agent',
      summary: '¿90 días?',
    })
  })

  it('a live run tells its status and, only when it waits for CI, ci', () => {
    expect(liveFacts(undefined)).toEqual({})
    expect(liveFacts(run({ status: 'running', agent_id: 'implementer' }))).toEqual({
      status: 'running',
      agent: 'implementer',
    })
    expect(
      liveFacts(run({ status: 'paused', pause: { pause_id: 'wait-ci', expires_at: 'x' } })),
    ).toMatchObject({ status: 'paused', pause_id: 'wait-ci', ci: 'true' })
  })
})

describe('buildTaskFacts', () => {
  it('measures idle and waiting time, counts blockers and carries the PR', () => {
    const activity: TaskActivity = {
      waiting: true,
      lastClosed: run({ closed_at: '2026-09-29T10:00:00Z' }),
      lastEventAt: '2026-09-29T11:00:00Z',
    }
    const facts = buildTaskFacts(
      card({ blockedBy: ['o/r#2'], pr: { number: 9, url: 'pr' } }),
      activity,
      { unlocks: 3, now },
    )
    expect(facts.task).toEqual({ idle_hours: 1, waiting_hours: 2, unlocks: 3, blocked_by: 1 })
    expect(facts.queue).toEqual({ waiting: true })
    expect(facts.pr).toEqual({ number: 9, url: 'pr' })
    expect(facts.item).toMatchObject({ status: 'Build', labels: ['blocked'], blocked: true })
  })

  it('without runs, waiting time counts from the card', () => {
    const facts = buildTaskFacts(card(), { waiting: false }, { unlocks: 0, now })
    expect(facts.task).toMatchObject({ idle_hours: 4, waiting_hours: 4 })
    expect(facts.run).toEqual({})
    expect(facts.live).toEqual({})
    expect(facts.pr).toBeUndefined()
  })
})

describe('unlocksOf', () => {
  it('counts how many cards each issue blocks', () => {
    const cards = [
      card({ ref: 'o/r#1', blockedBy: ['o/r#9'] }),
      card({ ref: 'o/r#2', blockedBy: ['o/r#9', 'o/r#8'] }),
    ]
    expect(unlocksOf(cards)).toEqual(
      new Map([
        ['o/r#9', 2],
        ['o/r#8', 1],
      ]),
    )
  })
})
