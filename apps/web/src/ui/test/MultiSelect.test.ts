import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import MultiSelect from '../MultiSelect.vue'

describe('MultiSelect', () => {
  it('renders selected values as removable chips', () => {
    const wrapper = mount(MultiSelect, {
      props: { modelValue: ['bug', 'urgent'], options: ['bug', 'urgent', 'wip'] },
    })
    const chips = wrapper.findAll('.ms-chip')
    expect(chips.map((c) => c.text())).toEqual(['bug ✕', 'urgent ✕'])
  })

  it('filters options as the user types', async () => {
    const wrapper = mount(MultiSelect, {
      props: { modelValue: [], options: ['bug', 'urgent', 'wip'] },
    })
    const input = wrapper.get('.ms-input')
    await input.trigger('focus')
    await input.setValue('ur')

    // Además de filtrar, ofrece crear «ur»: la query no coincide *exacto* con
    // ninguna opción, y sin esa salida una label nueva cuyo prefijo ya existe
    // sería inalcanzable.
    const optionTexts = wrapper.findAll('.ms-option').map((o) => o.text())
    expect(optionTexts).toEqual(['urgent', 'Crear «ur»'])
  })

  it('no ofrece crear cuando la query coincide exacto con una opción', async () => {
    const wrapper = mount(MultiSelect, {
      props: { modelValue: [], options: ['bug', 'urgent', 'wip'] },
    })
    const input = wrapper.get('.ms-input')
    await input.trigger('focus')
    await input.setValue('urgent')

    const optionTexts = wrapper.findAll('.ms-option').map((o) => o.text())
    expect(optionTexts).toEqual(['urgent'])
  })

  it('no ofrece crear cuando allowCustom es false', async () => {
    const wrapper = mount(MultiSelect, {
      props: { modelValue: [], options: ['bug'], allowCustom: false },
    })
    const input = wrapper.get('.ms-input')
    await input.trigger('focus')
    await input.setValue('nueva')

    expect(wrapper.findAll('.ms-option')).toHaveLength(0)
  })

  it('selects an option by click and emits update:modelValue', async () => {
    const wrapper = mount(MultiSelect, {
      props: { modelValue: [], options: ['bug', 'urgent'] },
    })
    const input = wrapper.get('.ms-input')
    await input.trigger('focus')
    await wrapper.get('.ms-option').trigger('mousedown')

    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([['bug']])
  })

  it('removes a value when its chip x is clicked', async () => {
    const wrapper = mount(MultiSelect, {
      props: { modelValue: ['bug', 'urgent'], options: ['bug', 'urgent'] },
    })
    await wrapper.get('.ms-chip .ms-chip-x').trigger('click')
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([['urgent']])
  })

  it('does not offer already-selected options and prevents duplicates', async () => {
    const wrapper = mount(MultiSelect, {
      props: { modelValue: ['bug'], options: ['bug', 'urgent'] },
    })
    const input = wrapper.get('.ms-input')
    await input.trigger('focus')

    // `bug` ya está elegido: sale de la lista para que no se pueda duplicar.
    const optionTexts = wrapper.findAll('.ms-option').map((o) => o.text())
    expect(optionTexts).toEqual(['urgent'])
  })

  it('no ofrece crear cuando la query coincide exacto con una opción', async () => {
    const wrapper = mount(MultiSelect, {
      props: { modelValue: [], options: ['bug', 'urgent', 'wip'] },
    })
    const input = wrapper.get('.ms-input')
    await input.trigger('focus')
    await input.setValue('urgent')

    const optionTexts = wrapper.findAll('.ms-option').map((o) => o.text())
    expect(optionTexts).toEqual(['urgent'])
  })

  it('no ofrece crear cuando allowCustom es false', async () => {
    const wrapper = mount(MultiSelect, {
      props: { modelValue: [], options: ['bug'], allowCustom: false },
    })
    const input = wrapper.get('.ms-input')
    await input.trigger('focus')
    await input.setValue('nueva')

    expect(wrapper.findAll('.ms-option')).toHaveLength(0)
  })

  it('offers "Crear «foo»" when allowCustom and the query matches nothing', async () => {
    const wrapper = mount(MultiSelect, {
      props: { modelValue: [], options: ['bug', 'urgent'] },
    })
    const input = wrapper.get('.ms-input')
    await input.trigger('focus')
    await input.setValue('brand-new-label')

    const custom = wrapper.get('.ms-option--custom')
    expect(custom.text()).toBe('Crear «brand-new-label»')

    await custom.trigger('mousedown')
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([['brand-new-label']])
  })

  it('does not offer a custom option when allowCustom is false', async () => {
    const wrapper = mount(MultiSelect, {
      props: { modelValue: [], options: ['bug'], allowCustom: false },
    })
    const input = wrapper.get('.ms-input')
    await input.trigger('focus')
    await input.setValue('brand-new-label')

    expect(wrapper.find('.ms-option--custom').exists()).toBe(false)
  })

  it('supports keyboard nav: ArrowDown + Enter selects the active option', async () => {
    const wrapper = mount(MultiSelect, {
      props: { modelValue: [], options: ['bug', 'urgent'] },
    })
    const input = wrapper.get('.ms-input')
    await input.trigger('focus')
    await input.trigger('keydown', { key: 'ArrowDown' })
    await input.trigger('keydown', { key: 'Enter' })

    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([['bug']])
  })

  it('Backspace on an empty input removes the last chip', async () => {
    const wrapper = mount(MultiSelect, {
      props: { modelValue: ['bug', 'urgent'], options: ['bug', 'urgent'] },
    })
    const input = wrapper.get('.ms-input')
    await input.trigger('keydown', { key: 'Backspace' })

    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([['bug']])
  })
})
