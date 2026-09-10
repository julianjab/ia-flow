import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import FormFooter from '../FormFooter.vue'

// Lo que se afirma acá no es el markup: es el contrato del pie de un formulario
// de configuración. Las cuatro variantes que existían en la app diferían justo
// en esto — quién dibuja Eliminar, dónde queda respecto de Guardar, y qué pasa
// en un ámbito heredado.
describe('FormFooter', () => {
  it('no dibuja Eliminar cuando no se le pasa deleteLabel', () => {
    const wrapper = mount(FormFooter)

    expect(wrapper.find('.btn--danger').exists()).toBe(false)
    expect(wrapper.get('.btn--primary').text()).toBe('Guardar')
    expect(wrapper.text()).toContain('Cancelar')
  })

  it('emite save, cancel y delete', async () => {
    const wrapper = mount(FormFooter, { props: { deleteLabel: 'Eliminar…' } })

    await wrapper.get('.btn--primary').trigger('click')
    await wrapper.get('.btn--danger').trigger('click')
    // El neutro es el único `.btn` sin variante.
    const cancel = wrapper.findAll('button').find((b) => b.text() === 'Cancelar')
    await cancel?.trigger('click')

    expect(wrapper.emitted('save')).toHaveLength(1)
    expect(wrapper.emitted('delete')).toHaveLength(1)
    expect(wrapper.emitted('cancel')).toHaveLength(1)
  })

  // R: en un ámbito heredado no se ofrece guardar. Un `Guardar` apagado dice
  // "acá se podría"; lo heredado se edita en otro lado.
  it('en readonly deja un solo Cerrar, sin Guardar ni Eliminar', () => {
    const wrapper = mount(FormFooter, {
      props: { readonly: true, deleteLabel: 'Eliminar…' },
    })

    expect(wrapper.find('.btn--primary').exists()).toBe(false)
    expect(wrapper.find('.btn--danger').exists()).toBe(false)
    expect(wrapper.findAll('button')).toHaveLength(1)
    expect(wrapper.get('button').text()).toBe('Cerrar')
  })

  it('deshabilita el primario con saveDisabled y muestra el note', () => {
    const wrapper = mount(FormFooter, {
      props: { saveDisabled: true, note: 'falta el prompt', noteIsError: true },
    })

    expect(wrapper.get('.btn--primary').attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('falta el prompt')
  })

  // Eliminar va del otro lado del pie que Guardar: separado por el ancho
  // entero. En el DOM eso es "aparece antes que el primario".
  it('pone Eliminar antes que Guardar en los dos modos', () => {
    for (const sticky of [true, false]) {
      const wrapper = mount(FormFooter, { props: { sticky, deleteLabel: 'Eliminar…' } })
      const texts = wrapper.findAll('button').map((b) => b.text())

      expect(texts.indexOf('Eliminar…')).toBeLessThan(texts.indexOf('Guardar'))
    }
  })

  it('sin sticky dibuja su propio note en vez del de StickyActionBar', () => {
    const wrapper = mount(FormFooter, {
      props: { sticky: false, note: '2 cambios sin guardar' },
    })

    expect(wrapper.find('.sab').exists()).toBe(false)
    expect(wrapper.get('.ffoot__note').text()).toBe('2 cambios sin guardar')
  })
})
