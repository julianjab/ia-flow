import { describe, expect, it } from 'bun:test'
import type { ExecutionSummary } from '@ia-flow/shared'
import {
  anytimeActions,
  type BoardCard,
  classify,
  inboxOrder,
  type TaskActivity,
} from './classify.js'
import { InboxSection } from './InboxSection.js'

const settings = InboxSection.parse({})
const now = new Date('2026-09-29T12:00:00Z')
const options = { settings, now }

const card = (patch: Partial<BoardCard> = {}): BoardCard => ({
  ref: 'la-haus/subscriptions#1',
  projectId: 'p',
  title: 'Una tarea',
  url: 'https://github.com/la-haus/subscriptions/issues/1',
  status: 'Build',
  labels: [],
  updatedAt: '2026-09-29T11:00:00Z',
  blockedBy: [],
  ...patch,
})

const run = (patch: Partial<ExecutionSummary> = {}): ExecutionSummary => ({
  id: 'e1',
  pipeline_id: 'build-reentry',
  status: 'running',
  started_at: '2026-09-29T11:50:00Z',
  ...patch,
})

const idle: TaskActivity = { waiting: false }

describe('classify', () => {
  it('a running execution wins over what the board says', () => {
    const result = classify(
      card({ status: 'Review', labels: ['reviewed'] }),
      {
        waiting: false,
        live: run({
          agent_id: 'reviewer',
          usage: { input_tokens: 30_000, output_tokens: 2_000, cache_read_tokens: 0 },
        }),
      },
      options,
    )
    expect(result).toMatchObject({ group: 'run', kind: 'agent', actions: ['stop', 'comment'] })
    expect(result?.why).toBe('build-reentry → reviewer corriendo · 32k tokens')
  })

  it('the tokens of an execution carry its estimated cost, when there is one', () => {
    const result = classify(
      card({ status: 'Review' }),
      {
        waiting: false,
        live: run({
          agent_id: 'reviewer',
          usage: { input_tokens: 30_000, output_tokens: 2_000, cache_read_tokens: 0 },
          cost: { usd: 0.16 },
        }),
      },
      options,
    )
    expect(result?.why).toBe('build-reentry → reviewer corriendo · 32k tokens (~$0.16 estimado)')
  })

  it('a pause on the CI shows as waiting for the CI', () => {
    const result = classify(
      card(),
      { waiting: false, live: run({ status: 'paused', pause: { pause_id: 'wait-ci' } }) },
      options,
    )
    expect(result).toMatchObject({ group: 'run', kind: 'ci' })
  })

  it('a run waiting its turn is queued', () => {
    expect(classify(card(), { waiting: true }, options)).toMatchObject({
      group: 'queue',
      kind: 'turn',
      since: '2026-09-29T11:00:00Z',
    })
  })

  it('Review + reviewed is ready to merge, only with a PR to merge', () => {
    const withPr = classify(
      card({ status: 'Review', labels: ['reviewed'], pr: { number: 7, url: 'u' } }),
      idle,
      options,
    )
    expect(withPr).toMatchObject({
      group: 'need',
      kind: 'merge',
      actions: ['merge', 'comment', 'close_pr'],
    })
    const withoutPr = classify(card({ status: 'Review', labels: ['reviewed'] }), idle, options)
    expect(withoutPr?.actions).toEqual(['comment'])
  })

  it('Review without reviewed always needs you, whatever else, with a review to re-run', () => {
    const stuck = card({ status: 'Review', itemId: 'PVTI_1', pr: { number: 7, url: 'u' } })
    expect(classify(stuck, idle, options)).toMatchObject({
      group: 'need',
      kind: 'review',
      why: 'Review sin reviewed · PR #7',
      actions: ['rerun_review', 'comment', 'close_pr'],
    })
    // Ni un blocker ni una corrida cerrada la mueven de ahí.
    expect(
      classify(
        { ...stuck, blockedBy: ['o/r#2'] },
        { waiting: false, lastClosed: run({ status: 'done' }) },
        options,
      ),
    ).toMatchObject({ group: 'need', kind: 'review' })
    // Sin PR no hay nada que revisar: se ve, pero sin la acción.
    expect(classify(card({ status: 'Review', itemId: 'PVTI_1' }), idle, options)?.actions).toEqual([
      'comment',
    ])
    // Mientras el reviewer corre, corre.
    expect(classify(stuck, { waiting: false, live: run() }, options)?.group).toBe('run')
  })

  it('Review + reviewed with a PR on the board also offers to re-run the review', () => {
    const reviewed = card({
      status: 'Review',
      labels: ['reviewed'],
      itemId: 'PVTI_1',
      pr: { number: 7, url: 'u' },
    })
    expect(classify(reviewed, idle, options)?.actions).toEqual([
      'merge',
      'rerun_review',
      'comment',
      'close_pr',
    ])
  })

  it('Refined asks for the PRD approval', () => {
    expect(classify(card({ status: 'Refined' }), idle, options)).toMatchObject({
      group: 'need',
      kind: 'prd',
      actions: ['approve_prd', 'back_to_refine', 'comment'],
    })
  })

  it('open blockers queue the task behind them', () => {
    expect(classify(card({ blockedBy: ['la-haus/subscriptions#2'] }), idle, options)).toMatchObject(
      { group: 'queue', kind: 'dep', why: 'Bloqueada por la-haus/subscriptions#2' },
    )
  })

  it('blocked by the agent failing its turn is a doubt; by the runtime, a crash', () => {
    const blocked = card({ labels: ['blocked'] })
    const doubt = classify(
      blocked,
      {
        waiting: false,
        lastClosed: run({
          status: 'done',
          closed_at: '2026-09-29T11:30:00Z',
          failure: { by: 'agent', message: '¿90 días o para siempre?' },
        }),
      },
      options,
    )
    expect(doubt).toMatchObject({
      group: 'need',
      kind: 'doubt',
      actions: ['answer_and_unblock', 'comment'],
    })
    expect(doubt?.why).toContain('¿90 días o para siempre?')

    const crash = classify(
      blocked,
      {
        waiting: false,
        lastClosed: run({
          status: 'failed',
          failure: { by: 'runtime', message: 'task budget exceeded' },
        }),
      },
      options,
    )
    expect(crash).toMatchObject({ group: 'fail', kind: 'crash', actions: ['retry', 'comment'] })
  })

  it('the agent exit decides: prerequisite is a missing piece, doubt is a decision', () => {
    const blocked = card({ labels: ['blocked'] })
    const closedBy = (exit: string, summary: string) => ({
      waiting: false,
      lastClosed: run({ status: 'done', closed_at: '2026-09-29T11:30:00Z', exit, summary }),
    })
    const missing = classify(blocked, closedBy('prerequisite', 'falta #1578'), options)
    expect(missing).toMatchObject({
      group: 'need',
      kind: 'prerequisite',
      actions: ['answer_and_unblock', 'comment'],
    })
    expect(missing?.why).toBe('Le falta una pieza: falta #1578')

    const asked = classify(blocked, closedBy('doubt', '¿90 días o para siempre?'), options)
    expect(asked).toMatchObject({ group: 'need', kind: 'doubt' })
    expect(asked?.why).toContain('¿90 días o para siempre?')
  })

  it('a doubt of the agent wins over waiting for another issue: it has to be answerable', () => {
    const waiting = card({ labels: ['blocked'], blockedBy: ['la-haus/subscriptions#1912'] })
    const asked = classify(
      waiting,
      {
        waiting: false,
        lastClosed: run({ status: 'done', exit: 'doubt', summary: '¿(a), (b) o (c)?' }),
      },
      options,
    )
    expect(asked).toMatchObject({
      group: 'need',
      kind: 'doubt',
      actions: ['answer_and_unblock', 'comment'],
    })
    expect(asked?.why).toContain('además espera a la-haus/subscriptions#1912')
    // Sin duda, sigue en la cola detrás de su prerrequisito.
    expect(
      classify(card({ blockedBy: ['la-haus/subscriptions#1912'] }), idle, options),
    ).toMatchObject({
      group: 'queue',
      kind: 'dep',
    })
  })

  it('a clean exit with blocked set but no doubt/prerequisite exit is not an agent question', () => {
    const done = classify(
      card({ labels: ['blocked'] }),
      { waiting: false, lastClosed: run({ status: 'done', exit: 'done' }) },
      options,
    )
    expect(done).toMatchObject({ group: 'fail', kind: 'crash' })
  })

  it('Refine or Build with no movement for staleHours is stale', () => {
    const stale = classify(card({ updatedAt: '2026-09-28T10:00:00Z' }), idle, options)
    expect(stale).toMatchObject({
      group: 'need',
      kind: 'stale',
      actions: ['relaunch', 'rerun_stage', 'comment'],
    })
    expect(stale?.why).toBe('Build sin movimiento hace 26 h')
    const recentEvent = classify(
      card({ updatedAt: '2026-09-28T10:00:00Z' }),
      { waiting: false, lastEventAt: '2026-09-29T11:00:00Z' },
      options,
    )
    expect(recentEvent).toBeUndefined()
  })

  it('what nobody needs to see stays out', () => {
    expect(classify(card({ status: 'Todo' }), idle, options)).toBeUndefined()
    expect(classify(card(), idle, options)).toBeUndefined()
  })
})

describe('inboxOrder', () => {
  it('what is not a decision: by group, oldest first', () => {
    const items = [
      { group: 'queue' as const, since: '1' },
      { group: 'run' as const, since: '3' },
      { group: 'run' as const, since: '2' },
      { group: 'queue' as const, since: '0' },
    ]
    expect(items.sort(inboxOrder).map((item) => `${item.group}:${item.since}`)).toEqual([
      'run:2',
      'run:3',
      'queue:0',
      'queue:1',
    ])
  })
})

describe('anytimeActions', () => {
  it('Refine or Build with nothing running can re-run its stage, and always comment', () => {
    expect(anytimeActions(card({ status: 'Build' }), idle, options.settings)).toEqual([
      'rerun_stage',
      'comment',
    ])
    expect(anytimeActions(card({ status: 'Refine' }), idle, options.settings)).toEqual([
      'rerun_stage',
      'comment',
    ])
  })

  it('while something runs or waits, or the card is blocked or elsewhere, only comment', () => {
    const settings = options.settings
    expect(anytimeActions(card(), { waiting: false, live: run() }, settings)).toEqual(['comment'])
    expect(anytimeActions(card(), { waiting: true }, settings)).toEqual(['comment'])
    expect(anytimeActions(card({ labels: ['blocked'] }), idle, settings)).toEqual(['comment'])
    expect(anytimeActions(card({ status: 'Todo' }), idle, settings)).toEqual(['comment'])
    expect(anytimeActions(card({ status: 'Review' }), idle, settings)).toEqual(['comment'])
  })

  it('a card with a PR can close it', () => {
    const withPr = card({ status: 'Review', pr: { number: 7, url: 'u' } })
    expect(anytimeActions(withPr, idle, options.settings)).toEqual(['comment', 'close_pr'])
  })
})

describe('classify — una task tomada en local (labels.local)', () => {
  const local = { settings: InboxSection.parse({ labels: { local: 'aiflow-local' } }), now }

  it('cae en su propio caso, sin acciones, aunque el board diga Review o algo corra', () => {
    const result = classify(
      card({ status: 'Review', labels: ['aiflow-local', 'reviewed'], pr: { number: 3, url: '' } }),
      { waiting: true, live: run() },
      local,
    )
    expect(result).toMatchObject({ group: 'run', kind: 'local', actions: [] })
    expect(result?.why).toBe('Tomada por una sesión local (aiflow-local)')
  })

  it('una tomada con blocked y un fallo tampoco ofrece retry ni relaunch', () => {
    const result = classify(
      card({ labels: ['aiflow-local', 'blocked'], updatedAt: '2026-09-20T00:00:00Z' }),
      { waiting: false, lastClosed: run({ status: 'failed', closed_at: '2026-09-20T00:00:00Z' }) },
      local,
    )
    expect(result).toMatchObject({ kind: 'local', actions: [] })
  })

  it('anytimeActions: ninguna sobre una tomada en local', () => {
    expect(anytimeActions(card({ labels: ['aiflow-local'] }), idle, local.settings)).toEqual([])
  })

  it('sin labels.local, el label no significa nada', () => {
    const result = classify(card({ labels: ['aiflow-local'] }), { waiting: true }, options)
    expect(result).toMatchObject({ kind: 'turn' })
  })
})

describe('classify — stop sobre una ejecución pausada', () => {
  it('se ofrece: parar una pausada la cancela', () => {
    const result = classify(
      card(),
      { waiting: false, live: run({ status: 'paused', pause: { pause_id: 'wait-ci' } }) },
      options,
    )
    expect(result).toMatchObject({ kind: 'ci', actions: ['stop', 'comment'] })
  })
})
