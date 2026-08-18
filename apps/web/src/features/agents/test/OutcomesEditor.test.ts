import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import type { AgentOutcomes } from '@ia-flow/shared'
import OutcomesEditor from '../OutcomesEditor.vue'

const PROJECT_FIELDS = [
  { name: 'Status', dataType: 'SINGLE_SELECT', options: ['Build', 'Done'] },
  { name: 'Labels', dataType: 'TEXT', options: ['design', 'wip', 'ci-checked'] },
]

function mountEditor(modelValue: AgentOutcomes = {}) {
  return mount(OutcomesEditor, {
    props: { modelValue, projectFields: PROJECT_FIELDS, statusOptions: ['Build', 'Done'] },
  })
}

/** Último payload emitido hacia el padre. */
function lastEmit(wrapper: ReturnType<typeof mountEditor>): AgentOutcomes {
  return wrapper.emitted('update:modelValue')?.at(-1)?.[0] as AgentOutcomes
}

describe('OutcomesEditor — una sola lista de campos por slot', () => {
  it('no renderiza una sección de labels aparte', () => {
    // Antes había 3 filas fijas (Añadir / Quitar / Reemplazar por) por slot.
    const wrapper = mountEditor()
    expect(wrapper.find('.oe-label-row').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Reemplazar por')
  })

  it('ofrece un "+ campo" por transición y ninguna fila al principio', () => {
    const wrapper = mountEditor()
    expect(wrapper.findAll('.oe-add')).toHaveLength(3)
    expect(wrapper.findAll('.oe-assign-row')).toHaveLength(0)
  })

  it('Labels aparece como una opción más del select de campo', async () => {
    const wrapper = mountEditor()
    await wrapper.findAll('.oe-add')[0].trigger('click')
    const options = wrapper
      .get('.oe-assign-field')
      .findAll('option')
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
    await wrapper.findAll('.oe-add')[1].trigger('click')
    await wrapper.setProps({ modelValue: lastEmit(wrapper) ?? {} })

    await wrapper.get('.oe-assign-field').setValue('Status')
    await wrapper.get('.oe-assign-value').setValue('Done')

    expect(lastEmit(wrapper)).toEqual({ onFinish: '$set:Status=Done' })
  })

  it('resincroniza cuando el cambio viene de afuera', async () => {
    const wrapper = mountEditor()
    await wrapper.findAll('.oe-add')[0].trigger('click')

    await wrapper.setProps({ modelValue: { onFinish: '$set:Status=Build' } })

    const fields = wrapper.findAll('.oe-assign-field')
    expect(fields).toHaveLength(1)
    expect((fields[0].element as HTMLSelectElement).value).toBe('Status')
  })
})

describe('OutcomesEditor — labels con signo', () => {
  it('hidrata una fila Labels desde el string $labels:', () => {
    const wrapper = mountEditor({ onFinishLabels: '$labels:+design,-wip' })
    const chips = wrapper.findAll('.loe-chip')
    expect(chips.map((c) => c.text())).toEqual(['+design✕', '-wip✕'])
  })

  it('el signo del chip alterna añadir → quitar y se emite', async () => {
    const wrapper = mountEditor({ onFinishLabels: '$labels:+design' })
    await wrapper.get('.loe-sign').trigger('click')
    expect(lastEmit(wrapper)).toEqual({ onFinishLabels: '$labels:-design' })
  })

  it('escribir una label la agrega como añadir por default', async () => {
    const wrapper = mountEditor()
    await wrapper.findAll('.oe-add')[1].trigger('click')
    await wrapper.setProps({ modelValue: lastEmit(wrapper) ?? {} })
    await wrapper.get('.oe-assign-field').setValue('Labels')

    const input = wrapper.get('.loe-input')
    await input.setValue('design')
    await input.trigger('keydown', { key: 'Enter' })

    expect(lastEmit(wrapper)).toEqual({ onFinishLabels: '$labels:+design' })
  })

  it('respeta un signo escrito a mano', async () => {
    const wrapper = mountEditor({ onErrorLabels: '$labels:+a' })
    const input = wrapper.get('.loe-input')
    await input.setValue('-b')
    await input.trigger('keydown', { key: 'Enter' })
    expect(lastEmit(wrapper)).toEqual({ onErrorLabels: '$labels:+a,-b' })
  })

  it('no permite duplicar una label ya elegida', async () => {
    const wrapper = mountEditor({ onErrorLabels: '$labels:+a' })
    const input = wrapper.get('.loe-input')
    await input.setValue('a')
    await input.trigger('keydown', { key: 'Enter' })
    expect(wrapper.findAll('.loe-chip')).toHaveLength(1)
  })

  it('quitar el chip borra el outcome de labels del slot', async () => {
    const wrapper = mountEditor({ onFinishLabels: '$labels:+design' })
    await wrapper.get('.loe-x').trigger('click')
    expect(lastEmit(wrapper)).toEqual({})
  })
})
