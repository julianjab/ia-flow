import type { WhenCondition } from '@ia-flow/shared'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import WhenConditionsEditor from '../WhenConditionsEditor.vue'

describe('WhenConditionsEditor', () => {
  it('renders no rows for an empty model', () => {
    const wrapper = mount(WhenConditionsEditor, { props: { modelValue: [] } })
    expect(wrapper.findAll('.wce-row')).toHaveLength(0)
  })

  it('renders one row per existing condition and no logic badge on the first', () => {
    const wrapper = mount(WhenConditionsEditor, {
      props: {
        modelValue: [
          { field: 'status', op: '=', value: 'Refined' },
          { field: 'priority', op: '!=', value: 'low', logic: 'or' },
        ],
      },
    })
    expect(wrapper.findAll('.wce-row')).toHaveLength(2)
    expect(wrapper.findAll('.wce-logic-badge')).toHaveLength(1)
    expect(wrapper.get('.wce-logic-badge').text()).toBe('OR')
  })

  it('adds a condition and emits update:modelValue', async () => {
    const wrapper = mount(WhenConditionsEditor, { props: { modelValue: [] } })
    await wrapper.get('.wce-add').trigger('click')
    expect(wrapper.findAll('.wce-row')).toHaveLength(1)
    const events = wrapper.emitted('update:modelValue')
    // Empty field is filtered out until the user types something.
    expect(events?.at(-1)?.[0]).toEqual([])
  })

  it('emits a WhenCondition once a field and value are filled in', async () => {
    const wrapper = mount(WhenConditionsEditor, { props: { modelValue: [] } })
    await wrapper.get('.wce-add').trigger('click')
    await wrapper.get('.wce-cell-field .wce-field').setValue('status')
    const events = wrapper.emitted('update:modelValue')
    const last = events?.at(-1)?.[0] as { field: string; op: string }[]
    expect(last).toEqual([{ field: 'status', op: '=', value: '' }])
  })

  it('removes a condition when its remove button is clicked', async () => {
    const wrapper = mount(WhenConditionsEditor, {
      props: { modelValue: [{ field: 'status', op: '=', value: 'Refined' }] },
    })
    await wrapper.get('.wce-remove').trigger('click')
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toEqual([])
  })

  it('uses a select for the field when projectFields are provided', () => {
    const wrapper = mount(WhenConditionsEditor, {
      props: {
        modelValue: [{ field: 'status', op: '=', value: 'Refined' }],
        projectFields: [
          { name: 'status', dataType: 'SINGLE_SELECT', options: ['Refined', 'Done'] },
        ],
      },
    })
    expect(wrapper.find('.wce-cell-field select.wce-field').exists()).toBe(true)
  })
})

describe('WhenConditionsEditor — agregar condiciones', () => {
  // Regresión: la fila nueva nace con `field: ''`, `entryToWhen` la filtra al
  // serializar, y el padre devolvía el array sin ella. El watcher entonces la
  // borraba de la lista local y "+ condición" no hacía nada visible.
  it('la fila agregada sobrevive al eco del padre', async () => {
    const wrapper = mount(WhenConditionsEditor, {
      props: { modelValue: [] as WhenCondition[] },
    })

    await wrapper.get('.wce-add').trigger('click')
    expect(wrapper.findAll('.wce-row')).toHaveLength(1)

    // El padre reenvía lo que se emitió (vacío, porque la fila está incompleta).
    const emitted = wrapper.emitted('update:modelValue')?.at(-1)?.[0] as WhenCondition[]
    expect(emitted).toEqual([])
    await wrapper.setProps({ modelValue: emitted })

    expect(wrapper.findAll('.wce-row')).toHaveLength(1)
  })

  it('permite completar la condición recién agregada y recién ahí la emite', async () => {
    const wrapper = mount(WhenConditionsEditor, {
      props: { modelValue: [] as WhenCondition[] },
    })
    await wrapper.get('.wce-add').trigger('click')
    await wrapper.setProps({ modelValue: [] })

    await wrapper.get('.wce-cell-field .wce-field').setValue('labels')
    const emitted = wrapper.emitted('update:modelValue')?.at(-1)?.[0] as WhenCondition[]
    expect(emitted).toEqual([{ field: 'labels', op: '=', value: '' }])
  })

  it('resincroniza cuando el cambio viene de afuera (hidratar otro agente)', async () => {
    const wrapper = mount(WhenConditionsEditor, {
      props: { modelValue: [] as WhenCondition[] },
    })
    await wrapper.get('.wce-add').trigger('click')

    await wrapper.setProps({
      modelValue: [{ field: 'type', op: '=', value: 'technical' }] as WhenCondition[],
    })

    const rows = wrapper.findAll('.wce-row')
    expect(rows).toHaveLength(1)
    expect((rows[0].find('.wce-cell-field .wce-field').element as HTMLInputElement).value).toBe(
      'type',
    )
  })
})

describe('WhenConditionsEditor — valores fuera del catálogo', () => {
  // Regresión: una condición guardada sobre un campo que el source no publica
  // en getFields (p. ej. `assignees` en un proyecto github-issues) se veía con
  // el select vacío, y el primer cambio de operador la pisaba sin que el
  // usuario supiera qué había ahí.
  it('muestra el campo guardado aunque no esté en projectFields', () => {
    const wrapper = mount(WhenConditionsEditor, {
      props: {
        modelValue: [{ field: 'assignees', op: '=', value: 'julianjab' }] as WhenCondition[],
        projectFields: [{ name: 'Labels', dataType: 'MULTI_SELECT', options: ['bug'] }],
      },
    })
    const select = wrapper.get('.wce-cell-field select.wce-field')
    expect(select.findAll('option').map((o) => o.attributes('value'))).toContain('assignees')
    expect((select.element as HTMLSelectElement).value).toBe('assignees')
  })

  it('muestra el valor guardado aunque ya no esté entre las opciones del campo', () => {
    const wrapper = mount(WhenConditionsEditor, {
      props: {
        modelValue: [{ field: 'Labels', op: '=', value: 'agent:e2e' }] as WhenCondition[],
        projectFields: [{ name: 'Labels', dataType: 'MULTI_SELECT', options: ['bug'] }],
      },
    })
    const select = wrapper.get('.wce-cell-value select.wce-field')
    expect((select.element as HTMLSelectElement).value).toBe('agent:e2e')
  })
})
