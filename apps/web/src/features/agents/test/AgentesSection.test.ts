import type { AgentDefinition } from '@ia-flow/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'
import AgentEditorModal from '../AgentEditorModal.vue'
import AgentesSection from '../AgentesSection.vue'

function agent(id: string, position: number, enabled?: boolean): AgentDefinition {
  return {
    id,
    provider: 'terminal-claude',
    prompt: `prompt ${id}`,
    position,
    enabled,
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
vi.mock('@/stores/toast', () => ({
  useToastStore: () => ({ success: vi.fn(), error: vi.fn() }),
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
  const wrapper = mount(AgentesSection, {
    props: { scope: 'global' as const },
    global: { stubs: { AgentEditorModal: true, ConfirmDialog: true } },
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
    fetchAgentsReadOnly.mockReset()
    fetchAgentsReadOnly.mockResolvedValue(false)
  })

  it('separa los deshabilitados en su propia sección', async () => {
    const wrapper = await mountSection([agent('a', 0), agent('b', 1, false), agent('c', 2, true)])
    expect(idsIn(wrapper, 'agents')).toEqual(['a', 'c'])
    expect(idsIn(wrapper, 'agents-disabled')).toEqual(['b'])
  })

  it('reordena por drag & drop mandando el scope completo, deshabilitados al final', async () => {
    // `setPositions` asigna position = índice del array recibido: mandar sólo
    // los habilitados dejaría a 'b' con una posición vieja intercalada.
    const wrapper = await mountSection([agent('a', 0), agent('b', 1, false), agent('c', 2)])
    const cards = wrapper.findAll('[data-kbd-list="agents"] .agent-card')
    await cards[1].trigger('dragstart')
    await cards[0].trigger('dragover')
    await cards[0].trigger('drop')
    await flushPromises()
    expect(reorderAgents).toHaveBeenCalledWith({ kind: 'global' }, ['c', 'a', 'b'])
  })

  it('deshabilita desde la lista y manda el agente al final del scope', async () => {
    const wrapper = await mountSection([agent('a', 0), agent('c', 1)])
    const toggles = wrapper.findAll('[data-kbd-list="agents"] .btn-toggle')
    expect(toggles[0].text()).toBe('Deshabilitar')
    await toggles[0].trigger('click')
    await flushPromises()
    expect(updateAgent).toHaveBeenCalledWith(
      { kind: 'global' },
      expect.objectContaining({ id: 'a', enabled: false }),
    )
    expect(reorderAgents).toHaveBeenCalledWith({ kind: 'global' }, ['c', 'a'])
  })

  it('vuelve a habilitar desde la sección de deshabilitados', async () => {
    const wrapper = await mountSection([agent('a', 0), agent('b', 1, false)])
    const toggle = wrapper.get('[data-kbd-list="agents-disabled"] .btn-toggle')
    expect(toggle.text()).toBe('Habilitar')
    await toggle.trigger('click')
    await flushPromises()
    expect(updateAgent).toHaveBeenCalledWith(
      { kind: 'global' },
      expect.objectContaining({ id: 'b', enabled: true }),
    )
    expect(reorderAgents).toHaveBeenCalledWith({ kind: 'global' }, ['a', 'b'])
  })

  it('cuando el scope es read-only, oculta "+ Agregar agente" y las acciones de cada tarjeta', async () => {
    fetchAgentsReadOnly.mockResolvedValue(true)
    const wrapper = await mountSection([agent('a', 0), agent('b', 1, false)])

    expect(wrapper.find('.btn-add-repo').exists()).toBe(false)
    expect(wrapper.find('.readonly-banner').exists()).toBe(true)
    expect(wrapper.find('[data-kbd-list="agents"] .agent-actions').exists()).toBe(false)
    expect(wrapper.find('[data-kbd-list="agents-disabled"] .agent-actions').exists()).toBe(false)
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

    const modal = wrapper.findComponent(AgentEditorModal)
    expect(modal.props('open')).toBe(true)
    expect(modal.props('agent')).toMatchObject({ id: 'a' })
    expect(modal.props('readonly')).toBe(true)
  })

  it('en un scope editable, el click en una tarjeta propia abre el editor en modo edición', async () => {
    fetchAgentsReadOnly.mockResolvedValue(false)
    const wrapper = await mountSection([agent('a', 0)])

    await wrapper.get('[data-kbd-list="agents"] .agent-card').trigger('click')

    expect(wrapper.findComponent(AgentEditorModal).props('readonly')).toBe(false)
  })
})
