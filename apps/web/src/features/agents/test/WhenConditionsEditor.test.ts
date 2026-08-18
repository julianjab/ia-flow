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
    await wrapper.get('.wce-cond-field').setValue('status')
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
    expect(wrapper.find('select.wce-cond-field').exists()).toBe(true)
  })
})
