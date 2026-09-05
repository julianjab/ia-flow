import type { AgentOutcomes } from '@ia-flow/shared'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import OutcomesEditor from '../OutcomesEditor.vue'

const PROJECT_FIELDS = [
  { name: 'Status', dataType: 'SINGLE_SELECT', options: ['Build', 'Done'] },
  { name: 'Labels', dataType: 'MULTI_SELECT', options: ['design', 'wip', 'ci-checked'] },
]

function mountEditor(
  modelValue: AgentOutcomes = {},
  projectFields: typeof PROJECT_FIELDS = PROJECT_FIELDS,
) {
  return mount(OutcomesEditor, {
    props: { modelValue, projectFields, statusOptions: ['Build', 'Done'] },
  })
}

/** Último payload emitido hacia el padre. */
function lastEmit(wrapper: ReturnType<typeof mountEditor>): AgentOutcomes {
  return wrapper.emitted('update:modelValue')?.at(-1)?.[0] as AgentOutcomes
}

/** Campo/valor ahora son un ComboBox: "elegir" es escribir el texto exacto y
 *  confirmarlo con Enter (o con blur), no un `<select>` con `.setValue()`. */
async function chooseCombo(
  wrapper: ReturnType<typeof mountEditor>,
  comboSelector: string,
  text: string,
) {
  const input = wrapper.get(`${comboSelector} .cb-input`)
  await input.setValue(text)
  await input.trigger('keydown', { key: 'Enter' })
}

describe('OutcomesEditor — una sola lista de campos por salida', () => {
  it('no renderiza una sección de labels aparte', () => {
    // Antes había 3 filas fijas (Añadir / Quitar / Reemplazar por) por slot.
    const wrapper = mountEditor()
    expect(wrapper.find('.oe-label-row').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Reemplazar por')
  })

  it('ofrece "+ campo" por sección y "+ salida", sin filas al principio', () => {
    const wrapper = mountEditor()
    // onProcess + '+ salida' + las dos salidas reservadas (success, error).
    expect(wrapper.findAll('.oe-add')).toHaveLength(4)
    expect(wrapper.findAll('.oe-assign-row')).toHaveLength(0)
  })

  it('Labels aparece como una opción más del combo de campo', async () => {
    const wrapper = mountEditor()
    await wrapper.findAll('.oe-add')[0].trigger('click')
    await wrapper.get('.oe-assign-field .cb-input').trigger('focus')
    const options = wrapper
      .get('.oe-assign-field')
      .findAll('.cb-opt__label')
      .map((o) => o.text())
    expect(options).toContain('Labels')
    expect(options).toContain('Status')
  })
})

describe('OutcomesEditor — "+ campo" (regresión)', () => {
  // La fila nueva nace vacía, `formToOutcomes` la filtra al serializar y el
  // padre devolvía un valor sin ella; el watcher la borraba antes de que el
  // usuario pudiera elegir el campo. El botón parecía muerto.
  it('la fila agregada sobrevive al eco del padre', async () => {
    const wrapper = mountEditor()

    await wrapper.findAll('.oe-add')[0].trigger('click')
    expect(wrapper.findAll('.oe-assign-row')).toHaveLength(1)

    await wrapper.setProps({ modelValue: lastEmit(wrapper) ?? {} })
    expect(wrapper.findAll('.oe-assign-row')).toHaveLength(1)
  })

  it('permite completar la fila y recién ahí emite el $set:', async () => {
    const wrapper = mountEditor()
    await wrapper.findAll('.oe-add')[2].trigger('click')
    await wrapper.setProps({ modelValue: lastEmit(wrapper) ?? {} })

    await chooseCombo(wrapper, '.oe-assign-field', 'Status')
    await chooseCombo(wrapper, '.oe-assign-value', 'Done')

    expect(lastEmit(wrapper)).toEqual({ exits: { success: '$set:Status=Done' } })
  })

  it('resincroniza cuando el cambio viene de afuera', async () => {
    const wrapper = mountEditor()
    await wrapper.findAll('.oe-add')[0].trigger('click')

    await wrapper.setProps({ modelValue: { exits: { success: '$set:Status=Build' } } })

    const fields = wrapper.findAll('.oe-assign-field')
    expect(fields).toHaveLength(1)
    expect((fields[0].find('.cb-input').element as HTMLInputElement).value).toBe('Status')
  })
})

describe('OutcomesEditor — campo multi-valor con signo', () => {
  it('un campo MULTI_SELECT que no se llama Labels también se edita con tokens', () => {
    // Lo decide el dataType del catálogo, no el nombre del campo.
    const wrapper = mountEditor({ exits: { success: '$set:Etiquetas=+design' } }, [
      { name: 'Etiquetas', dataType: 'MULTI_SELECT', options: ['design'] },
    ])
    expect(wrapper.findAll('.loe-chip').map((c) => c.text())).toEqual(['+design✕'])
  })

  it('hidrata una fila Labels desde el $set: del slot', () => {
    const wrapper = mountEditor({ exits: { success: '$set:Labels=+design,-wip' } })
    const chips = wrapper.findAll('.loe-chip')
    expect(chips.map((c) => c.text())).toEqual(['+design✕', '-wip✕'])
  })

  it('el signo del chip alterna añadir → quitar y se emite', async () => {
    const wrapper = mountEditor({ exits: { success: '$set:Labels=+design' } })
    await wrapper.get('.loe-sign').trigger('click')
    expect(lastEmit(wrapper)).toEqual({ exits: { success: '$set:Labels=-design' } })
  })

  it('escribir una label la agrega como añadir por default', async () => {
    const wrapper = mountEditor()
    await wrapper.findAll('.oe-add')[2].trigger('click')
    await wrapper.setProps({ modelValue: lastEmit(wrapper) ?? {} })
    await chooseCombo(wrapper, '.oe-assign-field', 'Labels')

    const input = wrapper.get('.loe-combo .cb-input')
    await input.setValue('design')
    await input.trigger('keydown', { key: 'Enter' })

    expect(lastEmit(wrapper)).toEqual({ exits: { success: '$set:Labels=+design' } })
  })

  it('respeta un signo escrito a mano', async () => {
    const wrapper = mountEditor({ exits: { error: '$set:Labels=+a' } })
    const input = wrapper.get('.loe-combo .cb-input')
    await input.setValue('-b')
    await input.trigger('keydown', { key: 'Enter' })
    expect(lastEmit(wrapper)).toEqual({ exits: { error: '$set:Labels=+a,-b' } })
  })

  it('no permite duplicar una label ya elegida', async () => {
    const wrapper = mountEditor({ exits: { error: '$set:Labels=+a' } })
    const input = wrapper.get('.loe-combo .cb-input')
    await input.setValue('a')
    await input.trigger('keydown', { key: 'Enter' })
    expect(wrapper.findAll('.loe-chip')).toHaveLength(1)
  })

  it('quitar el chip borra el outcome de labels del slot', async () => {
    const wrapper = mountEditor({ exits: { success: '$set:Labels=+design' } })
    await wrapper.get('.loe-x').trigger('click')
    expect(lastEmit(wrapper)).toEqual({})
  })
})
