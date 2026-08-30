import type { AgentDefinition } from '@ia-flow/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import AgentEditorModal from '../AgentEditorModal.vue'
import AgentesSection from '../AgentesSection.vue'

// AgentesSection ahora lee/escribe el agente abierto vía :agentId en la URL
// (ver resolveAgentFromRoute) en vez de un ref local — necesita un router
// real montado, no solo un stub, para que useRoute()/useRouter() funcionen.
const testRouter = createRouter({
  history: createMemoryHistory(),
  routes: [{ path: '/general/:tab/:agentId?', name: 'general', component: { template: '<div/>' } }],
})

function agent(id: string, position: number): AgentDefinition {
  return {
    id,
    provider: 'terminal-claude',
    prompt: `prompt ${id}`,
    position,
  } as AgentDefinition
}

const globalConfig = reactive<{ config: { agents: AgentDefinition[]; systemPrompts: [] } }>({
  config: { agents: [], systemPrompts: [] },
})
const fetchGlobal = vi.fn(async () => {})

vi.mock('@/features/project-config/globalStore', () => ({
  useGlobalConfigStore: () => Object.assign(globalConfig, { fetch: fetchGlobal }),
}))
vi.mock('@/features/project-config/store', () => ({
  useProjectConfigStore: () => ({ config: null, fetch: vi.fn(async () => {}) }),
}))
vi.mock('@/features/projects/store', () => ({
  useProjectsStore: () => ({ activeProjectId: null }),
}))
const toastError = vi.fn()
vi.mock('@/stores/toast', () => ({
  useToastStore: () => ({ success: vi.fn(), error: (...args: unknown[]) => toastError(...args) }),
}))
vi.mock('@/features/projects/availableApi', () => ({
  fetchAvailableAgents: vi.fn(async () => []),
  fetchAvailableSystemPrompts: vi.fn(async () => []),
}))

const reorderAgents = vi.fn(async () => {})
const updateAgent = vi.fn(async (_scope: unknown, a: AgentDefinition) => a)
const fetchAgentsReadOnly = vi.fn(async () => false)
vi.mock('@/features/project-config/crudApi', () => ({
  createAgent: vi.fn(async () => {}),
  deleteAgent: vi.fn(async () => {}),
  fetchAgentsReadOnly: () => fetchAgentsReadOnly(),
  reorderAgents: (...args: unknown[]) => reorderAgents(...(args as [])),
  updateAgent: (...args: unknown[]) => updateAgent(...(args as [never, AgentDefinition])),
}))

async function mountSection(agents: AgentDefinition[]) {
  globalConfig.config = { agents, systemPrompts: [] }
  await testRouter.push('/general/agentes')
  await testRouter.isReady()
  const wrapper = mount(AgentesSection, {
    props: { scope: 'global' as const },
    global: { plugins: [testRouter], stubs: { AgentEditorModal: true, ConfirmDialog: true } },
  })
  await flushPromises()
  return wrapper
}

function idsIn(wrapper: ReturnType<typeof mount>, list: string): string[] {
  return wrapper.findAll(`[data-kbd-list="${list}"] .agent-id`).map((el) => el.text())
}

describe('AgentesSection', () => {
  beforeEach(() => {
    reorderAgents.mockClear()
    updateAgent.mockClear()
    toastError.mockClear()
    fetchAgentsReadOnly.mockReset()
    fetchAgentsReadOnly.mockResolvedValue(false)
  })

  // Alfabético, no por `position`: desde la migración 059 el orden de esta
  // lista no decide nada —quién corre lo deciden las reglas— así que ordenar
  // por un campo que ya no significa nada daría un orden aparentemente
  // significativo que en realidad es arbitrario.
  it('lista los agentes del scope alfabéticamente, ignorando position', async () => {
    const wrapper = await mountSection([agent('c', 0), agent('a', 1), agent('b', 2)])
    expect(idsIn(wrapper, 'agents')).toEqual(['a', 'b', 'c'])
  })

  // El drag escribía `agent.position`, que ningún camino de selección lee desde
  // que las reglas decidieron el orden. Arrastrar tarjetas que no ordenan nada
  // es peor que no poder arrastrarlas.
  it('no ofrece reordenar: el orden de los agentes ya no decide nada', async () => {
    const wrapper = await mountSection([agent('a', 0), agent('b', 1), agent('c', 2)])
    const cards = wrapper.findAll('[data-kbd-list="agents"] .agent-card')

    expect(wrapper.find('.agent-drag-handle').exists()).toBe(false)
    expect(wrapper.find('.btn-move').exists()).toBe(false)
    expect(wrapper.find('.agent-order').exists()).toBe(false)

    await cards[1].trigger('dragstart')
    await cards[0].trigger('drop')
    await flushPromises()
    expect(reorderAgents).not.toHaveBeenCalled()
  })

  it('cuando el scope es read-only, oculta "+ Agregar agente" y las acciones de cada tarjeta', async () => {
    fetchAgentsReadOnly.mockResolvedValue(true)
    const wrapper = await mountSection([agent('a', 0), agent('b', 1)])

    expect(wrapper.find('.btn-add-repo').exists()).toBe(false)
    expect(wrapper.find('.readonly-banner').exists()).toBe(true)
    expect(wrapper.find('[data-kbd-list="agents"] .agent-actions').exists()).toBe(false)
  })

  it('cuando el scope es editable, muestra "+ Agregar agente" y no el banner', async () => {
    fetchAgentsReadOnly.mockResolvedValue(false)
    const wrapper = await mountSection([agent('a', 0)])

    expect(wrapper.find('.btn-add-repo').exists()).toBe(true)
    expect(wrapper.find('.readonly-banner').exists()).toBe(false)
    expect(wrapper.find('[data-kbd-list="agents"] .agent-actions').exists()).toBe(true)
  })

  it('aunque el scope sea read-only, el click en una tarjeta propia abre el editor en modo lectura', async () => {
    fetchAgentsReadOnly.mockResolvedValue(true)
    const wrapper = await mountSection([agent('a', 0)])

    await wrapper.get('[data-kbd-list="agents"] .agent-card').trigger('click')
    await flushPromises()

    expect(testRouter.currentRoute.value.params.agentId).toBe('a')
    const modal = wrapper.findComponent(AgentEditorModal)
    expect(modal.props('open')).toBe(true)
    expect(modal.props('agent')).toMatchObject({ id: 'a' })
    expect(modal.props('readonly')).toBe(true)
  })

  it('en un scope editable, el click en una tarjeta propia abre el editor en modo edición', async () => {
    fetchAgentsReadOnly.mockResolvedValue(false)
    const wrapper = await mountSection([agent('a', 0)])

    await wrapper.get('[data-kbd-list="agents"] .agent-card').trigger('click')
    await flushPromises()

    expect(wrapper.findComponent(AgentEditorModal).props('readonly')).toBe(false)
  })

  it('un :agentId que no existe (ya con el catálogo cargado) avisa y vuelve a la lista', async () => {
    const wrapper = await mountSection([agent('a', 0)])

    await testRouter.push('/general/agentes/nope')
    await flushPromises()

    expect(wrapper.findComponent(AgentEditorModal).props('open')).toBe(false)
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining('nope'))
    expect(testRouter.currentRoute.value.params.agentId).toBeUndefined()
    expect(wrapper.find('.settings-section').exists()).toBe(true)
  })
})
