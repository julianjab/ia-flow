import type { SystemPromptBlock } from '@ia-flow/shared'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import AgentHostSystemPromptCard from '../AgentHostSystemPromptCard.vue'

function mountCard(modelValue: SystemPromptBlock[] | null = []) {
  return mount(AgentHostSystemPromptCard, { props: { modelValue, saving: false } })
}

describe('AgentHostSystemPromptCard', () => {
  it('sin bloques, arranca vacío y "+ bloque" agrega uno', async () => {
    const wrapper = mountCard()
    expect(wrapper.findAll('textarea')).toHaveLength(0)

    await wrapper.find('.btn--add').trigger('click')
    expect(wrapper.findAll('textarea')).toHaveLength(1)
  })

  it('siembra los bloques existentes como texto', () => {
    const wrapper = mountCard([{ type: 'text', text: 'Estás en una VM efímera' }])
    expect((wrapper.find('textarea').element as HTMLTextAreaElement).value).toBe(
      'Estás en una VM efímera',
    )
  })

  it('no borra lo que el usuario está tipeando cuando el poll re-lee lo mismo', async () => {
    const blocks: SystemPromptBlock[] = [{ type: 'text', text: 'original' }]
    const wrapper = mountCard(blocks)

    await wrapper.find('textarea').setValue('editando…')
    // El console re-lee cada 5s: mismo contenido, array nuevo.
    await wrapper.setProps({ modelValue: [{ type: 'text', text: 'original' }] })

    expect((wrapper.find('textarea').element as HTMLTextAreaElement).value).toBe('editando…')
  })

  it('adopta lo del agent-host cuando cambió de verdad', async () => {
    const wrapper = mountCard([{ type: 'text', text: 'viejo' }])

    await wrapper.find('textarea').setValue('editando…')
    await wrapper.setProps({ modelValue: [{ type: 'text', text: 'del server' }] })

    expect((wrapper.find('textarea').element as HTMLTextAreaElement).value).toBe('del server')
  })

  it('quitar un bloque lo saca de la lista', async () => {
    const wrapper = mountCard([
      { type: 'text', text: 'uno' },
      { type: 'text', text: 'dos' },
    ])

    await wrapper.findAll('.btn--drop')[0]!.trigger('click')

    expect(wrapper.findAll('textarea')).toHaveLength(1)
    expect((wrapper.find('textarea').element as HTMLTextAreaElement).value).toBe('dos')
  })

  it('al guardar, descarta bloques vacíos y recorta espacios', async () => {
    const wrapper = mountCard([{ type: 'text', text: '  con espacios  ' }])
    await wrapper.find('.btn--add').trigger('click')
    // El segundo queda vacío — no se manda.

    await wrapper.find('.btn--primary').trigger('click')

    expect(wrapper.emitted('save')?.[0]?.[0]).toEqual([{ type: 'text', text: 'con espacios' }])
  })
})
