import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AgentActivationSection from '../AgentActivationSection.vue'

vi.mock('@/features/repos/api', () => ({
  getRepoMappings: vi.fn(async () => [{ name: 'repo-b' }, { name: 'repo-a' }]),
}))
vi.mock('@/features/projects/sourceApi', () => ({
  fetchProjectStatuses: vi.fn(async () => ({
    kind: 'github',
    statuses: [{ name: 'Refine' }, { name: 'Build' }],
  })),
  fetchProjectFields: vi.fn(async () => ({ kind: 'github', fields: [] })),
}))

function baseProps() {
  return {
    scope: 'project' as const,
    projectId: 'proj-1',
    projectName: 'Demo Project',
    repoName: null,
    statusName: null,
    when: [],
    enabled: true,
  }
}

describe('AgentActivationSection', () => {
  beforeEach(() => vi.clearAllMocks())

  it('names the project as context, not as an editable field', async () => {
    const wrapper = mount(AgentActivationSection, { props: baseProps() })
    await flushPromises()
    expect(wrapper.get('.aas-scope').text()).toBe('Demo Project')
    // El proyecto lo decide el scope donde se abrió el editor; no hay control.
    expect(wrapper.find('#aas-project').exists()).toBe(false)
  })

  it('oculta repo y status en scope global y explica por qué', async () => {
    // Antes se renderizaban deshabilitados / con una sola opción "Todos", que
    // sugiere que hay algo para elegir cuando no lo hay.
    const wrapper = mount(AgentActivationSection, {
      props: { ...baseProps(), scope: 'global', projectId: null, projectName: null },
    })
    await flushPromises()
    expect(wrapper.get('.aas-scope').text()).toContain('Global')
    expect(wrapper.find('#aas-repo').exists()).toBe(false)
    expect(wrapper.find('#aas-status').exists()).toBe(false)
    expect(wrapper.get('.aas-note').text()).toContain('sólo se definen condiciones')
    // Las condiciones sí se pueden definir sin proyecto.
    expect(wrapper.find('.wce-add').exists()).toBe(true)
  })

  it('muestra el control aunque no sea definible si ya hay un valor guardado', async () => {
    // Si no, un agente que quedó con repo/status de otro contexto no se podría
    // corregir ni limpiar desde la UI.
    const wrapper = mount(AgentActivationSection, {
      props: {
        ...baseProps(),
        scope: 'global',
        projectId: null,
        projectName: null,
        repoName: 'repo-a',
        statusName: 'Build',
      },
    })
    await flushPromises()
    expect(wrapper.find('#aas-repo').exists()).toBe(true)
    expect(wrapper.find('#aas-status').exists()).toBe(true)
  })

  it('loads repo and status options for the project scope and renders them', async () => {
    const wrapper = mount(AgentActivationSection, { props: baseProps() })
    await flushPromises()
    const repoOptions = wrapper
      .get('#aas-repo')
      .findAll('option')
      .map((o) => o.text())
    expect(repoOptions).toEqual(['Todos los repos', 'repo-a', 'repo-b'])
    const statusOptionsText = wrapper
      .get('#aas-status')
      .findAll('option')
      .map((o) => o.text())
    expect(statusOptionsText).toEqual(['Cualquier status', 'Refine', 'Build'])
  })

  it('emits update:repoName with null when "Todos los repos" is selected', async () => {
    const wrapper = mount(AgentActivationSection, {
      props: { ...baseProps(), repoName: 'repo-a' },
    })
    await flushPromises()
    await wrapper.get('#aas-repo').setValue('')
    expect(wrapper.emitted('update:repoName')?.at(-1)).toEqual([null])
  })

  it('emits update:enabled when the toggle is clicked', async () => {
    const wrapper = mount(AgentActivationSection, { props: baseProps() })
    await wrapper.get('.aas-toggle input').setValue(false)
    expect(wrapper.emitted('update:enabled')?.at(-1)).toEqual([false])
  })

  it('forwards when-condition changes from WhenConditionsEditor', async () => {
    const wrapper = mount(AgentActivationSection, { props: baseProps() })
    await wrapper.get('.wce-add').trigger('click')
    expect(wrapper.emitted('update:when')).toBeTruthy()
  })
})
