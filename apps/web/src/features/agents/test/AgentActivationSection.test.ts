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

  it('shows the project name read-only in project scope', () => {
    const wrapper = mount(AgentActivationSection, { props: baseProps() })
    expect(wrapper.get('.aas-readonly').text()).toBe('Demo Project')
  })

  it('shows "Global" and disables the repo select in global scope', () => {
    const wrapper = mount(AgentActivationSection, {
      props: { ...baseProps(), scope: 'global', projectId: null, projectName: null },
    })
    expect(wrapper.get('.aas-readonly').text()).toContain('Global')
    expect(wrapper.get('#aas-repo').attributes('disabled')).toBeDefined()
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
