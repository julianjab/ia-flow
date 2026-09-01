import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import FilterQueryInput from '../FilterQueryInput.vue'
import type { FilterFieldDef, FilterToken } from '../filter-query'

const fields: FilterFieldDef[] = [
  { key: 'agente', values: ['refiner', 'builder'] },
  { key: 'resultado', values: ['success', 'error'] },
  { key: 'tarea', hint: 'título o id' },
]

function mountInput(modelValue: FilterToken[] = []) {
  return mount(FilterQueryInput, { props: { modelValue, fields } })
}

async function type(wrapper: ReturnType<typeof mountInput>, value: string) {
  const input = wrapper.find('[data-testid="filter-query-input"]')
  await input.setValue(value)
  return input
}

describe('FilterQueryInput', () => {
  it('ofrece los campos mientras escribís el primer tramo', async () => {
    const wrapper = mountInput()
    await type(wrapper, 'age')

    const opts = wrapper.findAll('.fq-option')
    expect(opts).toHaveLength(1)
    expect(opts[0].text()).toContain('agente')
  })

  // Elegir el campo es el primer paso de UNA decisión, no el final: deja el
  // `campo:` escrito y pasa a ofrecer valores.
  it('elegir un campo abre sus valores sin emitir token', async () => {
    const wrapper = mountInput()
    await type(wrapper, 'age')
    await wrapper.find('[data-testid="filter-query-option-agente"]').trigger('mousedown')

    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    expect(wrapper.findAll('.fq-option').map((o) => o.text())).toEqual(['refiner', 'builder'])
  })

  it('elegir un valor emite el token', async () => {
    const wrapper = mountInput()
    await type(wrapper, 'agente:ref')
    await wrapper.find('[data-testid="filter-query-option-refiner"]').trigger('mousedown')

    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([
      [{ field: 'agente', value: 'refiner' }],
    ])
  })

  it('Enter toma la opción resaltada, y las flechas la mueven', async () => {
    const wrapper = mountInput()
    const input = await type(wrapper, 'agente:')
    await input.trigger('keydown', { key: 'ArrowDown' })
    await input.trigger('keydown', { key: 'Enter' })

    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([
      [{ field: 'agente', value: 'builder' }],
    ])
  })

  // Un campo de texto libre no tiene lista que elegir: Enter cierra lo escrito.
  it('Enter cierra un campo libre sin menú', async () => {
    const wrapper = mountInput()
    const input = await type(wrapper, 'tarea:login')
    expect(wrapper.findAll('.fq-option')).toHaveLength(0)
    await input.trigger('keydown', { key: 'Enter' })

    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([
      [{ field: 'tarea', value: 'login' }],
    ])
  })

  it('un click en el token lo quita', async () => {
    const wrapper = mountInput([
      { field: 'agente', value: 'refiner' },
      { field: 'resultado', value: 'error' },
    ])
    await wrapper.find('[data-testid="filter-query-token-agente-refiner"]').trigger('click')

    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([
      [{ field: 'resultado', value: 'error' }],
    ])
  })

  // Sólo con el borrador vacío: si no, borrar una letra se llevaría un token.
  it('backspace con el borrador vacío borra el último token', async () => {
    const wrapper = mountInput([{ field: 'agente', value: 'refiner' }])
    const input = wrapper.find('[data-testid="filter-query-input"]')
    await input.trigger('keydown', { key: 'Backspace' })
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([[]])

    const other = mountInput([{ field: 'agente', value: 'refiner' }])
    await type(other, 'x')
    await other.find('[data-testid="filter-query-input"]').trigger('keydown', { key: 'Backspace' })
    expect(other.emitted('update:modelValue')).toBeUndefined()
  })

  it('la × limpia todo', async () => {
    const wrapper = mountInput([{ field: 'agente', value: 'refiner' }])
    await wrapper.find('[data-testid="filter-query-clear"]').trigger('click')
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([[]])
  })
})
