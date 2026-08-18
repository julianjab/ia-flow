import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import OutcomesEditor from '../OutcomesEditor.vue'

describe('OutcomesEditor', () => {
  it('renders one Labels sub-section per outcome slot (arrancar / terminar / fallar)', () => {
    const wrapper = mount(OutcomesEditor, { props: { modelValue: {} } })

    const labelRows = wrapper.findAll('.oe-slot')
    expect(labelRows).toHaveLength(3)
    for (const slot of labelRows) {
      const rows = slot.findAll('.oe-label-row')
      expect(rows).toHaveLength(3)
      const actions = rows.map((r) => r.attributes('data-action'))
      expect(actions).toEqual(['add', 'remove', 'replace'])
    }
  })

  it('renders existing $set: assignments from the model', () => {
    const wrapper = mount(OutcomesEditor, {
      props: { modelValue: { onFinish: '$set:status=Done' } },
    })
    const finishSlot = wrapper.findAll('.oe-slot')[1]
    expect(finishSlot.find('.oe-assign-field').exists()).toBe(true)
  })

  it('renders existing chips for each label action from the model', () => {
    const wrapper = mount(OutcomesEditor, {
      props: { modelValue: { onFinishLabels: '$labels:+ci-checked,-stale' } },
    })
    const finishSlot = wrapper.findAll('.oe-slot')[1]
    const addRow = finishSlot.find('.oe-label-row[data-action="add"]')
    const removeRow = finishSlot.find('.oe-label-row[data-action="remove"]')
    expect(addRow.findAll('.ms-chip').map((c) => c.text())).toEqual(['ci-checked ✕'])
    expect(removeRow.findAll('.ms-chip').map((c) => c.text())).toEqual(['stale ✕'])
  })

  it('creates a custom label chip on Enter and emits update:modelValue with $labels: serialized', async () => {
    const wrapper = mount(OutcomesEditor, { props: { modelValue: {} } })
    const finishSlot = wrapper.findAll('.oe-slot')[1]
    const input = finishSlot.get('.oe-label-row[data-action="add"] .ms-input')
    await input.trigger('focus')
    await input.setValue('ci-checked')
    await input.trigger('keydown', { key: 'Enter' })

    const events = wrapper.emitted('update:modelValue')
    expect(events).toBeTruthy()
    const patch = events!.at(-1)?.[0] as { onFinishLabels?: string }
    expect(patch.onFinishLabels).toBe('$labels:+ci-checked')
  })

  it('selects a catalog label from projectFields.Labels.options', async () => {
    const wrapper = mount(OutcomesEditor, {
      props: {
        modelValue: {},
        projectFields: [{ name: 'Labels', dataType: 'labels', options: ['bug', 'urgent'] }],
      },
    })
    const processSlot = wrapper.findAll('.oe-slot')[0]
    const row = processSlot.get('.oe-label-row[data-action="add"]')
    await row.get('.ms-input').trigger('focus')
    await row.get('.ms-option').trigger('mousedown')

    const events = wrapper.emitted('update:modelValue')
    const patch = events!.at(-1)?.[0] as { onProcessLabels?: string }
    expect(patch.onProcessLabels).toBe('$labels:+bug')
  })

  it('removes a chip when its ✕ button is clicked', async () => {
    const wrapper = mount(OutcomesEditor, {
      props: { modelValue: { onErrorLabels: '$labels:=bug,=regression' } },
    })
    const errorSlot = wrapper.findAll('.oe-slot')[2]
    const replaceRow = errorSlot.get('.oe-label-row[data-action="replace"]')
    const chips = replaceRow.findAll('.ms-chip')
    expect(chips).toHaveLength(2)
    await chips[0].get('.ms-chip-x').trigger('click')

    const events = wrapper.emitted('update:modelValue')
    const patch = events!.at(-1)?.[0] as { onErrorLabels?: string }
    expect(patch.onErrorLabels).toBe('$labels:=regression')
  })

  it('adds and fills a field assignment, emitting the $set: string', async () => {
    const wrapper = mount(OutcomesEditor, { props: { modelValue: {} } })
    const processSlot = wrapper.findAll('.oe-slot')[0]
    await processSlot.get('.oe-add').trigger('click')
    await processSlot.get('.oe-assign-field').setValue('status')
    await processSlot.get('.oe-assign-value').setValue('In Progress')

    const events = wrapper.emitted('update:modelValue')
    const patch = events!.at(-1)?.[0] as { onProcess?: string }
    expect(patch.onProcess).toBe('$set:status=In Progress')
  })
})
