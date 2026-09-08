import RulesSection from '@/features/rules/RulesSection.vue'
import type { Pipeline, Rule } from '@ia-flow/shared'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'

// Buscador (`FilterQueryInput`, campo:valor) y agrupado por `on[0]` — ver
// `RulesSection.vue` (`matchesToken`, `groupByEvent`). Mismo router real que
// el resto de los tests de esta sección: useRoute() sin router explota.
const testRouter = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: '/general/:tab/:detailId?', name: 'general', component: { template: '<div/>' } },
  ],
})

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
  vocabulary: { agentIds: [], statuses: [], repos: [], actionIds: [] },
}

let rules: Rule[] = []

vi.mock('@/features/rules/api', () => ({
  fetchRules: vi.fn(async () => ({ rules, inherited: [], readOnly: false })),
  fetchActionKinds: vi.fn(async () => ['agent', 'http', 'emit']),
  fetchPipeline: vi.fn(async () => empty),
  createRule: vi.fn(),
  updateRule: vi.fn(),
  deleteRule: vi.fn(),
  reorderRules: vi.fn(),
  fetchActions: vi.fn(async () => ({ actions: [], inherited: [], readOnly: false })),
  createAction: vi.fn(),
  updateAction: vi.fn(),
  deleteAction: vi.fn(),
}))
vi.mock('@/stores/toast', () => ({
  useToastStore: () => ({ success: vi.fn(), error: vi.fn() }),
}))

enableAutoUnmount(afterEach)

async function mountSection() {
  await testRouter.replace('/general/pipeline')
  await testRouter.isReady()
  const w = mount(RulesSection, {
    props: { scope: { kind: 'global' as const } },
    global: {
      plugins: [testRouter],
      stubs: { RuleEditorModal: true, ConfirmDialog: true, NamedActionsSection: true },
    },
  })
  await flushPromises()
  return w
}

/** Escribe un token `campo:valor` y lo confirma como haría un operador: el
 *  segundo `:` abre las sugerencias de VALOR, y como sólo hay una que
 *  matchea exacto, Enter aplica esa. */
async function typeToken(w: Awaited<ReturnType<typeof mountSection>>, raw: string) {
  const input = w.get('[data-testid="rules-filter-input"]')
  await input.setValue(raw)
  await input.trigger('keydown.enter')
}

describe('RulesSection — buscador y agrupado', () => {
  beforeEach(() => {
    rules = [
      rule({ id: 'build-a', on: ['issue.status_changed'] }),
      rule({ id: 'build-b', on: ['issue.status_changed'] }),
      rule({ id: 'pr-changes', on: ['pr.review_submitted'] }),
    ]
  })

  it('agrupa reglas consecutivas del mismo evento bajo un separador', async () => {
    const w = await mountSection()
    const dividers = w.findAll('.rs-divider').map((e) => e.text())
    expect(dividers).toEqual(['issue.status_changed', 'pr.review_submitted'])
    // El orden real (prioridad de matcheo) no se toca: agrupar no reordena.
    expect(w.findAll('.rs-id').map((e) => e.text())).toEqual(['build-a', 'build-b', 'pr-changes'])
  })

  it('un token evento: sólo deja las reglas de ese evento', async () => {
    const w = await mountSection()
    await typeToken(w, 'evento:pr.review_submitted')

    expect(w.findAll('.rs-id').map((e) => e.text())).toEqual(['pr-changes'])
    expect(w.findAll('.rs-divider')).toHaveLength(1)
  })

  it('un token agente: filtra por el agente que la regla despacha', async () => {
    rules.push(rule({ id: 'reviewer-rule', do: [{ action: 'agent', agentId: 'reviewer' }] }))
    const w = await mountSection()
    await typeToken(w, 'agente:reviewer')

    expect(w.findAll('.rs-id').map((e) => e.text())).toEqual(['reviewer-rule'])
  })

  it('texto libre matchea sin nombrar campo', async () => {
    const w = await mountSection()
    await typeToken(w, 'changes')

    expect(w.findAll('.rs-id').map((e) => e.text())).toEqual(['pr-changes'])
  })

  // `evento` es de lista cerrada (`values: eventOptions`): un valor que no
  // matchea ninguna regla cargada no llega a ser token — mismo criterio que
  // Logs, ver `tokenFromDraft`. El texto libre sí acepta cualquier cosa.
  it('sin resultados, muestra el motivo con los tokens activos', async () => {
    const w = await mountSection()
    await typeToken(w, 'q:no-matchea-nada')

    expect(w.findAll('.rs-item')).toHaveLength(0)
    expect(w.find('.rs-empty').text()).toContain('q:no-matchea-nada')
  })

  it('mientras se busca, no se puede arrastrar', async () => {
    const w = await mountSection()
    expect(w.find('.rs-item').attributes('draggable')).toBe('true')

    await typeToken(w, 'evento:pr.review_submitted')
    expect(w.find('.rs-item').attributes('draggable')).toBe('false')
    expect(w.find('.rs-drag').exists()).toBe(false)
  })
})
