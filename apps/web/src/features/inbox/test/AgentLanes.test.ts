import type { ExecutionAgent } from '@ia-flow/shared'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { execution, item } from '@/features/inbox/test/fixtures'

vi.mock('@/features/inbox/api', () => ({
  getInbox: vi.fn(),
  getTasks: vi.fn(),
  getTaskDetail: vi.fn(),
  postTaskAction: vi.fn(),
}))

import AgentLanes from '@/features/inbox/AgentLanes.vue'
import DecisionDetail from '@/features/inbox/decisions/DecisionDetail.vue'
import ExecutionRow from '@/features/inbox/ExecutionRow.vue'
import RunningList from '@/features/inbox/pipeline/RunningList.vue'
import { runningOf } from '@/features/inbox/queue/build'
import { entryOf } from '@/features/inbox/queue/entries'

const NOW = Date.parse('2026-01-01T10:12:00.000Z')

const agent = (
  agent_id: string,
  state: ExecutionAgent['state'],
  over: Partial<ExecutionAgent> = {},
) => ({
  agent_id,
  state,
  started_at: '2026-01-01T10:00:00.000Z',
  last_step_at: '2026-01-01T10:10:00.000Z',
  ...over,
})

const PARALLEL = [
  agent('reviewer', 'done'),
  agent('e2e-visual-qa', 'running', { idle_seconds: 130 }),
]
const review = (agents: ExecutionAgent[] = PARALLEL) =>
  execution({ pipeline_id: 'review', agent_id: 'reviewer', agents })

describe('AgentLanes', () => {
  it('cada agente con su estado: «reviewer ✓ · e2e-visual-qa ● hace 2 min»', () => {
    const w = mount(AgentLanes, { props: { agents: PARALLEL } })
    const lanes = w.findAll('[role="listitem"]')
    expect(lanes).toHaveLength(2)
    expect(lanes[0]?.text()).toContain('reviewer')
    expect(lanes[0]?.text()).toContain('✓')
    expect(lanes[0]?.attributes('data-tone')).toBe('ok')
    expect(lanes[1]?.text()).toContain('e2e-visual-qa')
    expect(lanes[1]?.text()).toContain('hace 2 min')
    expect(lanes[1]?.attributes('data-tone')).toBe('live')
    // El estado se dice en palabras, no sólo con el color del glifo.
    expect(lanes[1]?.find('.sr-only').text()).toBe('corriendo')
  })

  it('falló e interrumpido llevan su tono', () => {
    const w = mount(AgentLanes, {
      props: { agents: [agent('reviewer', 'failed'), agent('e2e-visual-qa', 'interrupted')] },
    })
    expect(w.findAll('[role="listitem"]').map((l) => l.attributes('data-tone'))).toEqual([
      'bad',
      'warn',
    ])
  })

  it('con uno solo, o sin agents, no dibuja nada', () => {
    expect(
      mount(AgentLanes, { props: { agents: [agent('implementer', 'running')] } }).html(),
    ).not.toContain('al__lane')
    expect(mount(AgentLanes, { props: {} }).find('[data-test="agent-lanes"]').exists()).toBe(false)
  })
})

describe('donde se usa', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('la lista de lo que corre: los agentes en paralelo en vez del último que cerró', () => {
    const items = [
      item({ ref: 'o/r#1', group: 'run', execution: execution() }),
      item({ ref: 'o/r#2', group: 'run', execution: review() }),
    ]
    const w = mount(RunningList, { props: { running: runningOf(items, NOW) } })
    const [single, parallel] = w.findAll('[data-test="running"]')
    expect(single?.text()).toContain('· implementer')
    expect(single?.find('[data-test="agent-lanes"]').exists()).toBe(false)
    expect(parallel?.find('[data-test="agent-lanes"]').text()).toContain('e2e-visual-qa')
    expect(parallel?.text()).toContain('hace 2 min')
  })

  it('la fila de una ejecución: se nombra por su pipeline y abajo cada agente', () => {
    const w = mount(ExecutionRow, { props: { execution: review(), open: false, trace: [] } })
    expect(w.get('.xr__agent').text()).toBe('review')
    expect(w.get('[data-test="agent-lanes"]').text()).toContain('reviewer')
    expect(w.get('[data-test="agent-lanes"]').text()).toContain('e2e-visual-qa')
  })

  it('la fila de una ejecución de un solo agente queda como siempre', () => {
    const w = mount(ExecutionRow, {
      props: {
        execution: execution({ agents: [agent('implementer', 'running')] }),
        open: false,
        trace: [],
      },
    })
    expect(w.get('.xr__agent').text()).toBe('implementer')
    expect(w.find('[data-test="agent-lanes"]').exists()).toBe(false)
  })

  it('el detalle de una decisión muestra los agentes si corrió más de uno', () => {
    const entry = entryOf(
      item({ kind: 'stale', group: 'need', actions: [], execution: review() }),
      1,
      NOW,
      2,
    )
    const w = mount(DecisionDetail, { props: { entry } })
    expect(w.text()).toContain('Agentes')
    expect(w.get('[data-test="agent-lanes"]').text()).toContain('e2e-visual-qa')

    const solo = entryOf(
      item({ kind: 'stale', group: 'need', actions: [], execution: execution() }),
      1,
      NOW,
      2,
    )
    expect(
      mount(DecisionDetail, { props: { entry: solo } })
        .find('[data-test="agent-lanes"]')
        .exists(),
    ).toBe(false)
  })
})
