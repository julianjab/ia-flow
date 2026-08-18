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
      const actions = rows.map((r) => r.get('.oe-action-label').attributes('data-action'))
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
    const addChips = finishSlot.findAll('.oe-chip[data-action="add"]')
    const removeChips = finishSlot.findAll('.oe-chip[data-action="remove"]')
    expect(addChips.map((c) => c.text())).toEqual(['ci-checked ✕'])
    expect(removeChips.map((c) => c.text())).toEqual(['stale ✕'])
  })

  it('commits a chip on Enter and emits update:modelValue with $labels: serialized', async () => {
    const wrapper = mount(OutcomesEditor, { props: { modelValue: {} } })
    const input = wrapper.get('[data-labels-input="onFinishLabels.add"]')
    await input.setValue('ci-checked')
    await input.trigger('keydown', { key: 'Enter' })

    const events = wrapper.emitted('update:modelValue')
    expect(events).toBeTruthy()
    const patch = events!.at(-1)?.[0] as { onFinishLabels?: string }
    expect(patch.onFinishLabels).toBe('$labels:+ci-checked')
  })

  it('splits comma-separated input into multiple chips', async () => {
    const wrapper = mount(OutcomesEditor, { props: { modelValue: {} } })
    const input = wrapper.get('[data-labels-input="onProcessLabels.add"]')
    await input.setValue('a, b, c')
    await input.trigger('blur')

    const events = wrapper.emitted('update:modelValue')
    const patch = events!.at(-1)?.[0] as { onProcessLabels?: string }
    expect(patch.onProcessLabels).toBe('$labels:+a,+b,+c')
  })

  it('removes a chip when its ✕ button is clicked', async () => {
    const wrapper = mount(OutcomesEditor, {
      props: { modelValue: { onErrorLabels: '$labels:=bug,=regression' } },
    })
    const errorSlot = wrapper.findAll('.oe-slot')[2]
    const replaceChips = errorSlot.findAll('.oe-chip[data-action="replace"]')
    expect(replaceChips).toHaveLength(2)
    await replaceChips[0].get('.oe-chip-x').trigger('click')

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
