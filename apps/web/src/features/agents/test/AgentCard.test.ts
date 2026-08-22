import type { AgentDefinition } from '@ia-flow/shared'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import AgentCard from '../AgentCard.vue'

function agent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: 'a',
    provider: 'anthropic-api',
    prompt: 'do it',
    ...overrides,
  } as AgentDefinition
}

describe('AgentCard', () => {
  it('emite edit al click cuando es editable', async () => {
    const wrapper = mount(AgentCard, { props: { agent: agent() } })
    await wrapper.find('.agent-card').trigger('click')
    expect(wrapper.emitted('edit')).toHaveLength(1)
  })

  it('sigue emitiendo edit al click aunque sea readonly — solo pierde las acciones', async () => {
    const wrapper = mount(AgentCard, { props: { agent: agent(), readonly: true } })
    await wrapper.find('.agent-card').trigger('click')
    expect(wrapper.emitted('edit')).toHaveLength(1)
    expect(wrapper.find('.agent-actions').exists()).toBe(false)
  })

  it('muestra las acciones (editar/toggle/eliminar/mover) cuando no es readonly', () => {
    const wrapper = mount(AgentCard, { props: { agent: agent() } })
    expect(wrapper.find('.agent-actions').exists()).toBe(true)
  })
})
