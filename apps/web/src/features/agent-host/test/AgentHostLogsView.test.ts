import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import LogStreamSection from '@/components/LogStreamSection.vue'

const isAgentHostSelected = vi.fn(() => true)
vi.mock('../connection', () => ({
  isAgentHostSelected: () => isAgentHostSelected(),
  selectedAgentHostClient: () => ({}),
  selectedAgentHostUrl: () => 'http://localhost:3012',
}))

import AgentHostLogsView from '../AgentHostLogsView.vue'

describe('AgentHostLogsView', () => {
  it('monta la MISMA vista de logs que el server, sin live/field-filters/sort y con polling', () => {
    isAgentHostSelected.mockReturnValue(true)
    const wrapper = mount(AgentHostLogsView, {
      global: { stubs: { LogStreamSection: true } },
    })

    const section = wrapper.findComponent(LogStreamSection)
    expect(section.exists()).toBe(true)
    expect(section.props()).toMatchObject({
      title: 'Logs del agent-host',
      live: false,
      fieldFilters: false,
      sortable: false,
      pollMs: 5000,
    })
    expect(typeof section.props('fetchLogs')).toBe('function')
  })

  it('sin un agent-host elegido, no monta la vista — deja la pista de a dónde ir', () => {
    isAgentHostSelected.mockReturnValue(false)
    const wrapper = mount(AgentHostLogsView, {
      global: { stubs: { LogStreamSection: true } },
    })

    expect(wrapper.findComponent(LogStreamSection).exists()).toBe(false)
    expect(wrapper.text()).toContain('no es un agent-host')
  })
})
