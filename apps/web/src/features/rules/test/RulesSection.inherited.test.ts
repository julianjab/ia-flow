// Lo que un proyecto puede hacer con una regla GLOBAL: no editarla, decidir si
// corre acá.

import RulesSection from '@/features/rules/RulesSection.vue'
import * as api from '@/features/rules/api'
import ToggleSwitch from '@/ui/ToggleSwitch.vue'
import type { Pipeline, Rule } from '@ia-flow/shared'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'

const testRouter = createRouter({
  history: createMemoryHistory(),
  routes: [
    {
      path: '/projects/:id/:tab/:detailId?',
      name: 'projects.detail',
      component: { template: '<div/>' },
    },
  ],
})

const rule = (over: Partial<Rule> = {}): Rule =>
  ({
    id: 'r-global',
    on: ['issue.scanned'],
    do: [{ action: 'agent', agentId: 'refiner' }],
    projectId: null,
    ...over,
  }) as Rule

const empty: Pipeline = {
  rules: [],
  running: [],
  waits: [],
  gaps: { unusedAgents: [], statusesWithoutRules: [] },
  vocabulary: { agentIds: [], statuses: [], repos: [], actionIds: [] },
}

let inherited: Rule[] = []
let disabledHere: string[] = []

vi.mock('@/features/rules/api', () => ({
  fetchRules: vi.fn(async () => ({ rules: [], inherited, disabledHere, readOnly: false })),
  fetchActionKinds: vi.fn(async () => ['agent']),
  fetchPipeline: vi.fn(async () => empty),
  setRuleEnabledInProject: vi.fn(async () => []),
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

async function mountForProject() {
  await testRouter.replace('/projects/p1/pipeline')
  await testRouter.isReady()
  const w = mount(RulesSection, {
    props: { scope: { kind: 'project' as const, projectId: 'p1' } },
    global: {
      plugins: [testRouter],
      stubs: { RuleEditorModal: true, ConfirmDialog: true, NamedActionsSection: true },
    },
  })
  await flushPromises()
  return w
}

describe('RulesSection — globales heredadas', () => {
  beforeEach(() => {
    inherited = [rule()]
    disabledHere = []
    vi.mocked(api.setRuleEnabledInProject).mockReset()
    vi.mocked(api.setRuleEnabledInProject).mockResolvedValue([])
  })

  it('una global dada de baja SIGUE en la lista — si no, no habría cómo volver', async () => {
    disabledHere = ['r-global']

    const w = await mountForProject()

    expect(w.text()).toContain('r-global')
    expect(w.findComponent(ToggleSwitch).props('modelValue')).toBe(false)
  })

  it('el interruptor refleja que corre, no la acción de apagarla', async () => {
    const w = await mountForProject()

    expect(w.findComponent(ToggleSwitch).props('modelValue')).toBe(true)
  })

  it('apagarla manda el id y la intención, no la lista', async () => {
    // La lista la comparten todas las reglas del proyecto: mandarla entera
    // desde dos pestañas hace que la segunda deshaga la baja de la primera.
    const w = await mountForProject()

    await w.findComponent(ToggleSwitch).vm.$emit('update:modelValue', false)
    await flushPromises()

    expect(api.setRuleEnabledInProject).toHaveBeenCalledWith('r-global', 'p1', false)
  })

  it('volver a prenderla manda `enabled: true`', async () => {
    disabledHere = ['r-global']
    const w = await mountForProject()

    await w.findComponent(ToggleSwitch).vm.$emit('update:modelValue', true)
    await flushPromises()

    expect(api.setRuleEnabledInProject).toHaveBeenCalledWith('r-global', 'p1', true)
  })

  it('una apagada en General no ofrece el interruptor', async () => {
    // No corre en ningún lado y desde acá no se puede prender: un interruptor
    // que no puede cambiar nada miente sobre lo que se controla desde esta
    // pantalla.
    inherited = [rule({ enabled: false })]

    const w = await mountForProject()

    expect(w.text()).toContain('deshabilitada')
    expect(w.findComponent(ToggleSwitch).exists()).toBe(false)
  })

  it('la fila de tags no tiene ningún control', async () => {
    // Los tags describen la regla; lo accionable va a la zona de acciones de la
    // tarjeta. Mezclados, no había forma de saber cuál se podía clickear.
    inherited = [rule({ exclusive: true })]

    const w = await mountForProject()

    const tagRow = w.find('.rs-item-top')
    // Sin esto el test pasa igual cuando la fila no existe.
    expect(tagRow.exists()).toBe(true)
    expect(tagRow.text()).toContain('exclusiva')
    expect(tagRow.findComponent(ToggleSwitch).exists()).toBe(false)
    expect(w.findComponent(ToggleSwitch).exists()).toBe(true)
  })
})
