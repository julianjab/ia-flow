import type { TaskFact, Tasks } from '@ia-flow/shared'
import { beforeEach, describe, expect, it } from 'vitest'
import { DashboardError, parseDashboard } from '@/features/inbox/view/dashboard'
import { buildView, decide } from '@/features/inbox/view/decide'
import { PRESETS } from '@/features/inbox/view/presets'
import { resolveDashboard, serverKey } from '@/features/inbox/view/resolve'
import { saveOverride } from '@/features/inbox/view/storage'

const text = (name: string) => PRESETS.find((preset) => preset.name === name)?.text ?? ''
const standard = parseDashboard(text('default'))
const lahaus = parseDashboard(text('ia-flow.ss.lahaus.com'))

/** Una tarea sin nada especial: una card en Build que nadie tocó. */
function fact(patch: Partial<TaskFact> & { facts?: Partial<TaskFact> } = {}): TaskFact {
  const { facts, ...rest } = patch
  return {
    ref: 'la-haus/subscriptions#1',
    project_id: 'p',
    title: 'Una tarea',
    url: 'https://github.com/la-haus/subscriptions/issues/1',
    updated_at: '2026-09-29T08:00:00Z',
    item: {
      status: 'Build',
      type: 'technical',
      repos: ['subscriptions'],
      labels: [],
      blocked: false,
    },
    run: {},
    live: {},
    queue: { waiting: false },
    task: { idle_hours: 1, waiting_hours: 1, unlocks: 0, blocked_by: 0 },
    blocked_by_refs: [],
    actions: [],
    action_defs: [],
    ...facts,
    ...rest,
  }
}

const run = (patch: Record<string, unknown> = {}) => ({
  id: 'e',
  pipeline_id: 'refine',
  status: 'done' as const,
  started_at: '2026-09-29T09:00:00Z',
  closed_at: '2026-09-29T11:30:00Z',
  ...patch,
})

const blockedItem = {
  status: 'Blocked',
  type: 'technical',
  repos: ['r'],
  labels: ['blocked'],
  blocked: false,
}

describe('dashboards that ship with the web', () => {
  it('are valid, and the default declares no server', () => {
    expect(PRESETS.map((preset) => preset.name)).toEqual(['default', 'ia-flow.ss.lahaus.com'])
    expect(standard.server).toBeUndefined()
    expect(lahaus.server).toBe('https://ia-flow.ss.lahaus.com')
  })

  it("the runner's own dashboard is picked by its URL, and any other gets the default", () => {
    expect(resolveDashboard(serverKey('https://ia-flow.ss.lahaus.com/')).source).toBe('preset')
    expect(resolveDashboard(serverKey('https://IA-FLOW.ss.lahaus.com')).source).toBe('preset')
    expect(resolveDashboard(serverKey('http://localhost:3001')).source).toBe('default')
    expect(serverKey('')).toBe('local')
  })
})

describe('which dashboard a runner gets', () => {
  beforeEach(() => localStorage.clear())

  it('what someone edited for that runner wins over the one the web ships', () => {
    saveOverride(serverKey('https://ia-flow.ss.lahaus.com'), text('default'))
    expect(resolveDashboard('https://ia-flow.ss.lahaus.com').source).toBe('override')
  })

  it('an edited one that is invalid does not break the screen: it falls back and says why', () => {
    saveOverride('https://ia-flow.ss.lahaus.com', 'decisions: []')
    const resolved = resolveDashboard('https://ia-flow.ss.lahaus.com')
    expect(resolved.source).toBe('preset')
    expect(resolved.warning).toContain('no es válido')
  })
})

describe('parseDashboard', () => {
  it('says where a document is wrong', () => {
    expect(() => parseDashboard('decisions: [ { id: x } ]')).toThrow(DashboardError)
    expect(() => parseDashboard('decisions: [ { id: x } ]')).toThrow(/decisions\.0\.group/)
    expect(() => parseDashboard('a: [')).toThrow(/YAML inválido/)
  })

  it('rejects a key it does not know, so a typo is not silently ignored', () => {
    const doc = `decisions:\n  - { id: a, group: need, kind: merge, why: x, wen: [] }`
    expect(() => parseDashboard(doc)).toThrow(/wen|Unrecognized/)
  })
})

describe('the default dashboard classifies like the inbox always did', () => {
  const classify = (task: TaskFact) => decide(task, standard)

  it('what runs wins over what the board says', () => {
    const item = classify(
      fact({
        item: { status: 'Review', type: 't', repos: [], labels: ['reviewed'], blocked: false },
        live: { status: 'running', agent: 'implementer' },
        live_run: run({ status: 'running', agent_id: 'implementer', closed_at: undefined }),
        actions: ['stop', 'merge'],
      }),
    )
    expect(item).toMatchObject({ group: 'run', kind: 'agent', actions: ['stop'] })
    expect(item?.why).toBe('refine → implementer corriendo')
  })

  it('a paused run is CI when it says so, otherwise just paused', () => {
    const paused = (extra: Record<string, string>) =>
      classify(
        fact({
          live: { status: 'paused', pause_id: 'wait-ci', ...extra },
          live_run: run({ status: 'paused', pause: { pause_id: 'wait-ci' } }),
        }),
      )
    expect(paused({ ci: 'true' })).toMatchObject({ group: 'run', kind: 'ci' })
    expect(paused({})).toMatchObject({ group: 'run', kind: 'agent' })
    expect(paused({})?.why).toBe('Pausada en wait-ci')
  })

  it('waiting its turn is queued', () => {
    expect(classify(fact({ queue: { waiting: true } }))).toMatchObject({
      group: 'queue',
      kind: 'turn',
    })
  })

  it('Review is merge with reviewed and review without it; Refined is a PRD to approve', () => {
    const review = (labels: string[]) =>
      classify(
        fact({
          item: { status: 'Review', type: 't', repos: [], labels, blocked: false },
          pr: { number: 12, url: 'u' },
          actions: ['merge', 'rerun_review'],
        }),
      )
    expect(review(['reviewed'])).toMatchObject({ group: 'need', kind: 'merge', actions: ['merge'] })
    expect(review(['reviewed'])?.why).toBe('Review + reviewed · PR #12')
    expect(review([])).toMatchObject({ kind: 'review', actions: ['rerun_review'] })
    expect(
      classify(
        fact({
          item: { status: 'Refined', type: 't', repos: [], labels: [], blocked: false },
          actions: ['approve_prd', 'back_to_refine'],
        }),
      ),
    ).toMatchObject({ kind: 'prd', actions: ['approve_prd', 'back_to_refine'] })
  })

  it('open blockers queue the task behind them', () => {
    expect(
      classify(
        fact({
          blocked_by_refs: ['la-haus/subscriptions#2'],
          task: { idle_hours: 1, waiting_hours: 1, unlocks: 0, blocked_by: 1 },
        }),
      ),
    ).toMatchObject({ group: 'queue', kind: 'dep', why: 'Bloqueada por la-haus/subscriptions#2' })
  })

  it('blocked: the agent exit decides — prerequisite or doubt; a runtime failure is a crash', () => {
    const blocked = (runFacts: Record<string, string>, last = run()) =>
      classify(
        fact({
          item: blockedItem,
          run: runFacts,
          last_run: last,
          actions: ['answer_and_unblock', 'retry'],
        }),
      )
    expect(blocked({ exit: 'prerequisite', summary: 'falta #1578' })).toMatchObject({
      group: 'need',
      kind: 'prerequisite',
      why: 'Le falta una pieza: falta #1578',
      agent_said: 'falta #1578',
      actions: ['answer_and_unblock'],
    })
    expect(blocked({ failure_by: 'agent', summary: '¿90 días o para siempre?' })).toMatchObject({
      kind: 'doubt',
    })
    expect(blocked({ exit: 'doubt', summary: 'x' })).toMatchObject({ kind: 'doubt' })
    expect(
      blocked({ failure_by: 'runtime', status: 'failed', summary: 'task budget exceeded' }),
    ).toMatchObject({
      group: 'fail',
      kind: 'crash',
      actions: ['retry'],
    })
    expect(blocked({})).toMatchObject({
      group: 'fail',
      kind: 'crash',
      why: 'Bloqueada (blocked) sin una corrida que diga por qué',
    })
  })

  it('a failed run without blocked is a crash too; a clean one is nothing', () => {
    expect(
      classify(fact({ run: { status: 'failed', summary: 'boom' }, actions: ['retry'] })),
    ).toMatchObject({
      group: 'fail',
      kind: 'crash',
    })
    expect(classify(fact({ run: { status: 'done', exit: 'done' } }))).toBeUndefined()
  })

  it('Refine or Build with no movement for a day is stale', () => {
    const stale = classify(
      fact({
        task: { idle_hours: 26, waiting_hours: 26, unlocks: 0, blocked_by: 0 },
        actions: ['relaunch'],
      }),
    )
    expect(stale).toMatchObject({ group: 'need', kind: 'stale', actions: ['relaunch'] })
    expect(stale?.why).toBe('Build sin movimiento hace 26 h')
    expect(
      classify(fact({ task: { idle_hours: 2, waiting_hours: 2, unlocks: 0, blocked_by: 0 } })),
    ).toBeUndefined()
  })

  it('a card nobody has to touch is not an item; Backlog neither', () => {
    expect(
      classify(
        fact({ item: { status: 'Backlog', type: 't', repos: [], labels: [], blocked: false } }),
      ),
    ).toBeUndefined()
  })

  it('shows only what the runner offers: no action offered, no button', () => {
    const item = classify(
      fact({
        item: { status: 'Refined', type: 't', repos: [], labels: [], blocked: false },
        actions: ['back_to_refine'],
      }),
    )
    expect(item?.actions).toEqual(['back_to_refine'])
  })
})

describe('ordering', () => {
  const tasks = (list: TaskFact[]): Tasks => ({
    generated_at: 'x',
    projects: [],
    tasks: list,
    capacity: { running: 0, waiting: 0, paused: 0 },
  })

  it('nearest to Done first, then the oldest', () => {
    const at = (
      ref: string,
      status: string,
      labels: string[] = [],
      updated = '2026-09-29T08:00:00Z',
    ) =>
      fact({
        ref,
        item: { status, type: 't', repos: [], labels, blocked: false },
        updated_at: updated,
      })
    const view = buildView(
      tasks([
        at('o/r#1', 'Refined'),
        at('o/r#2', 'Review', ['reviewed']),
        at('o/r#3', 'Review'),
        at('o/r#4', 'Refined', [], '2026-09-28T08:00:00Z'),
      ]),
      standard,
    )
    expect(view.items.map((item) => item.ref)).toEqual(['o/r#2', 'o/r#3', 'o/r#4', 'o/r#1'])
  })
})

describe("the claw-agents runner's dashboard", () => {
  const view = (
    list: TaskFact[],
    capacity = { running: 1, waiting: 0, paused: 0, max_concurrent: 4, free: 3 },
  ) => buildView({ generated_at: 'x', projects: [], tasks: list, capacity }, lahaus)

  it('names each decision: merge, PRDs, a doubt, a missing piece, a runner crash, an unexplained block', () => {
    const items = view([
      fact({
        ref: 'o/r#1638',
        item: {
          status: 'Review',
          type: 't',
          repos: [],
          labels: ['reviewed', 'blocked'],
          blocked: false,
        },
        pr: { number: 1679, url: 'u' },
        task: { idle_hours: 1, waiting_hours: 1, unlocks: 2, blocked_by: 0 },
        actions: ['merge', 'rerun_review'],
      }),
      fact({
        ref: 'o/r#1672',
        item: { status: 'Refined', type: 't', repos: [], labels: [], blocked: false },
        run: { summary: 'No encontré desvíos' },
        actions: ['approve_prd', 'back_to_refine'],
      }),
      fact({
        ref: 'o/r#1582',
        item: blockedItem,
        run: { exit: 'doubt', summary: '¿sigue el proxy?' },
        actions: ['answer_and_unblock'],
      }),
      fact({
        ref: 'o/r#1579',
        item: blockedItem,
        run: { exit: 'prerequisite', summary: 'falta #1578' },
        actions: ['answer_and_unblock'],
      }),
      fact({
        ref: 'o/r#1637',
        item: blockedItem,
        run: {
          failure_by: 'runtime',
          status: 'failed',
          agent: 'refiner',
          summary: '400 final block',
        },
        actions: ['retry'],
      }),
      fact({ ref: 'o/r#1669', item: blockedItem, actions: ['answer_and_unblock', 'retry'] }),
    ]).items
    const by = (ref: string) => items.find((item) => item.ref === ref)
    expect(by('o/r#1638')).toMatchObject({
      verb: 'Decidir el merge',
      primary: 'merge',
      chips: [
        { text: 'a un merge de Done', tone: 'hot' },
        { text: 'destraba 2', tone: 'hot' },
        { text: 'blocked y reviewed a la vez', tone: 'warn' },
      ],
    })
    expect(by('o/r#1672')).toMatchObject({
      verb: 'Aprobar el PRD',
      primary: 'approve_prd',
      agent_said: 'No encontré desvíos',
    })
    expect(by('o/r#1582')?.verb).toBe('Tomar una decisión de producto')
    expect(by('o/r#1579')).toMatchObject({
      kind: 'prerequisite',
      verb: 'Encadenarla detrás de lo que le falta',
    })
    expect(by('o/r#1637')).toMatchObject({
      verb: 'Relanzar el refiner',
      chips: [{ text: 'falló el runner, no el agente', tone: 'bad' }],
    })
    expect(by('o/r#1669')?.verb).toBe('Anotar por qué está bloqueada')
  })

  it('orders them: merge, PRD, the runner crash, the doubt, the missing piece, the unexplained block', () => {
    const order = view([
      fact({ ref: 'a', item: blockedItem }),
      fact({ ref: 'b', item: blockedItem, run: { exit: 'prerequisite', summary: 'x' } }),
      fact({ ref: 'c', item: blockedItem, run: { exit: 'doubt', summary: 'x' } }),
      fact({
        ref: 'd',
        item: blockedItem,
        run: { failure_by: 'runtime', status: 'failed', summary: 'x' },
      }),
      fact({
        ref: 'e',
        item: { status: 'Refined', type: 't', repos: [], labels: [], blocked: false },
      }),
      fact({
        ref: 'f',
        item: { status: 'Review', type: 't', repos: [], labels: ['reviewed'], blocked: false },
      }),
    ]).items.map((item) => item.ref)
    expect(order).toEqual(['f', 'e', 'd', 'c', 'b', 'a'])
  })

  it('a PRD that unlocks more goes first among equals', () => {
    const prd = (ref: string, unlocks: number) =>
      fact({
        ref,
        item: { status: 'Refined', type: 't', repos: [], labels: [], blocked: false },
        task: { idle_hours: 1, waiting_hours: 1, unlocks, blocked_by: 0 },
      })
    expect(view([prd('o/r#1', 0), prd('o/r#2', 3)]).items.map((item) => item.ref)).toEqual([
      'o/r#2',
      'o/r#1',
    ])
  })

  it('the pipeline panel carries the runner capacity; the feed lists what Todo can start', () => {
    const todo = (ref: string, patch: Partial<TaskFact> = {}) =>
      fact({
        ref,
        item: { status: 'Todo', type: 't', repos: [], labels: [], blocked: false },
        ...patch,
      })
    const result = view([
      todo('o/r#1', {
        actions: ['start_refine'],
        action_defs: [{ id: 'start_refine', label: 'Mover a Refine' }],
      }),
      todo('o/r#2', { task: { idle_hours: 1, waiting_hours: 1, unlocks: 0, blocked_by: 1 } }),
      fact({ ref: 'o/r#3' }),
    ])
    expect(result.capacity).toMatchObject({ free: 3, max_concurrent: 4 })
    expect(result.feed?.entries).toEqual([
      {
        ref: 'o/r#1',
        title: 'Una tarea',
        url: expect.any(String),
        action: { id: 'start_refine', label: 'Mover a Refine' },
      },
    ])
  })

  it('counts the hygiene lines over the open cards', () => {
    const result = view([
      fact({ ref: 'a', item: blockedItem }),
      fact({ ref: 'b', item: blockedItem, run: { status: 'done' } }),
      fact({ ref: 'c' }),
    ])
    expect(result.hygiene).toEqual([
      { text: '1 abiertas con blocked pero sin ninguna corrida', count: 1 },
    ])
  })
})
