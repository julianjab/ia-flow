import RulesSection from '@/features/rules/RulesSection.vue'
import type { Pipeline, Rule } from '@ia-flow/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const rule = (over: Partial<Rule> = {}): Rule =>
  ({
    id: 'r1',
    on: ['issue.status_changed'],
    do: [{ action: 'agent', agentId: 'refiner' }],
    ...over,
  }) as Rule

const empty: Pipeline = {
  rules: [],
  running: [],
  waits: [],
  gaps: { unusedAgents: [], statusesWithoutRules: [] },
}

let pipeline: Pipeline = empty
let rules: Rule[] = []

vi.mock('@/features/rules/api', () => ({
  fetchRules: vi.fn(async () => ({ rules, readOnly: false })),
  fetchActionKinds: vi.fn(async () => ['agent', 'http', 'emit']),
  fetchPipeline: vi.fn(async () => pipeline),
  createRule: vi.fn(),
  updateRule: vi.fn(),
  deleteRule: vi.fn(),
  reorderRules: vi.fn(),
}))
vi.mock('@/stores/toast', () => ({
  useToastStore: () => ({ success: vi.fn(), error: vi.fn() }),
}))

async function mountSection() {
  const w = mount(RulesSection, {
    props: { scope: { kind: 'global' as const } },
    global: { stubs: { RuleEditorModal: true, ConfirmDialog: true } },
  })
  await flushPromises()
  return w
}

describe('RulesSection — lo que corre encima', () => {
  beforeEach(() => {
    rules = [rule()]
    pipeline = { ...empty }
  })

  // La decisión que ordena la pantalla: el run se dibuja SOBRE la regla que lo
  // lanzó. "Qué pasa" y "por qué pasa" es una sola pregunta.
  it('cuelga el run de la regla que lo lanzó', async () => {
    pipeline = {
      ...empty,
      running: [
        {
          taskId: 't1',
          issueNumber: 482,
          agentId: 'refiner',
          ruleId: 'r1',
          status: 'x',
          isSubAgent: false,
        },
      ],
    }

    const w = await mountSection()
    expect(w.find('.rs-run').text()).toContain('refiner · #482')
    expect(w.find('.rs-running').text()).toContain('1 corriendo')
  })

  // Colgarlo de una regla equivocada es peor que no mostrarlo acá.
  it('un run sin regla no se cuelga de ninguna', async () => {
    pipeline = {
      ...empty,
      running: [{ taskId: 't1', agentId: 'suelto', status: 'x', isSubAgent: false }],
    }

    const w = await mountSection()
    expect(w.find('.rs-run').exists()).toBe(false)
    expect(w.find('.rs-running').text()).toContain('1 corriendo')
  })

  it('distingue una pausa de una espera por el glifo', async () => {
    pipeline = {
      ...empty,
      waits: [
        {
          id: 'w1',
          taskId: 't1',
          agentId: 'a',
          on: ['task.message'],
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          isPause: true,
        },
        {
          id: 'w2',
          taskId: 't2',
          agentId: 'b',
          on: ['ci.finished'],
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          isPause: false,
        },
      ],
    }

    const w = await mountSection()
    const texts = w.findAll('.rs-wait').map((e) => e.text())
    expect(texts[0]).toContain('⏸')
    expect(texts[1]).toContain('○')
  })

  it('avisa de los agentes que ninguna regla usa', async () => {
    pipeline = { ...empty, gaps: { unusedAgents: ['releaser'], statusesWithoutRules: [] } }

    const w = await mountSection()
    expect(w.find('.rs-gap').text()).toContain('releaser')
    expect(w.find('.rs-gap').text()).toContain('nunca van a correr')
  })

  it('avisa de los statuses sin ninguna regla', async () => {
    pipeline = { ...empty, gaps: { unusedAgents: [], statusesWithoutRules: ['Bloqueado'] } }

    const w = await mountSection()
    expect(w.find('.rs-gap').text()).toContain('Bloqueado')
  })

  // Perder el overlay no puede impedir editar una regla: el CRUD es la función
  // primaria de la pantalla y no depende del pipeline.
  it('si el pipeline falla, el listado sigue andando', async () => {
    const api = await import('@/features/rules/api')
    vi.mocked(api.fetchPipeline).mockRejectedValueOnce(new Error('502'))

    const w = await mountSection()
    expect(w.findAll('.rs-item')).toHaveLength(1)
    expect(w.find('.rs-running').exists()).toBe(false)
  })
})
