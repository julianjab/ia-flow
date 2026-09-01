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

  it('sigue emitiendo edit al click aunque sea readonly', async () => {
    const wrapper = mount(AgentCard, { props: { agent: agent(), readonly: true } })
    await wrapper.find('.agent-card').trigger('click')
    expect(wrapper.emitted('edit')).toHaveLength(1)
  })

  it('la tarjeta no tiene acciones — ni siquiera siendo editable', () => {
    // Borrar vive en el detalle, y habilitar/deshabilitar ya no existe: desde
    // la migración 059 un agente no declara si corre, lo decide la regla que lo
    // dispara. El botón que había acá no estaba cableado a nada — prometía
    // apagar un agente que ninguna pantalla podía apagar.
    const wrapper = mount(AgentCard, { props: { agent: agent() } })
    expect(wrapper.findAll('.editable-card__actions button')).toHaveLength(0)
  })
})
