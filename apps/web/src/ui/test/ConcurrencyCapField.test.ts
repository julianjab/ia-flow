import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ConcurrencyCapField from '../ConcurrencyCapField.vue'

describe('ConcurrencyCapField', () => {
  it('muestra el label de herencia cuando no hay valor', () => {
    const wrapper = mount(ConcurrencyCapField, {
      props: { modelValue: null, label: 'Máx.', inheritLabel: 'Sin límite' },
    })
    expect(wrapper.text()).toContain('Efectivo: Sin límite')
    expect(wrapper.get('input').element.value).toBe('')
  })

  it('muestra el valor efectivo cuando hay cap', () => {
    const wrapper = mount(ConcurrencyCapField, { props: { modelValue: 3, label: 'Máx.' } })
    expect(wrapper.text()).toContain('Efectivo: 3 en paralelo')
    expect(wrapper.get('input').element.value).toBe('3')
  })

  it('emite el número parseado', async () => {
    const wrapper = mount(ConcurrencyCapField, { props: { modelValue: null, label: 'Máx.' } })
    await wrapper.get('input').setValue('4')
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([4])
  })

  it('vaciar el campo emite null, no undefined — el PATCH mergea por key', () => {
    const wrapper = mount(ConcurrencyCapField, { props: { modelValue: 2, label: 'Máx.' } })
    return wrapper
      .get('input')
      .setValue('')
      .then(() => {
        expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([null])
      })
  })

  it('un 0 se normaliza a null — nunca significa "frenar todo"', async () => {
    const wrapper = mount(ConcurrencyCapField, { props: { modelValue: 2, label: 'Máx.' } })
    await wrapper.get('input').setValue('0')
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([null])
  })
})
