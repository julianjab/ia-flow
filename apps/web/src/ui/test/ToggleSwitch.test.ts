import ToggleSwitch from '@/ui/ToggleSwitch.vue'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

describe('ToggleSwitch', () => {
  it('es un switch accesible que declara su estado', () => {
    // `role="switch"` + `aria-checked` y no un botón pelado: el estado tiene
    // que estar en el DOM, no sólo en el color del track.
    const on = mount(ToggleSwitch, { props: { modelValue: true, ariaLabel: 'Correr acá' } })

    expect(on.attributes('role')).toBe('switch')
    expect(on.attributes('aria-checked')).toBe('true')
    expect(on.attributes('aria-label')).toBe('Correr acá')
  })

  it('emite el valor invertido', async () => {
    const w = mount(ToggleSwitch, { props: { modelValue: false } })

    await w.trigger('click')

    expect(w.emitted('update:modelValue')?.[0]).toEqual([true])
  })

  it('mientras hay una escritura en vuelo no emite', async () => {
    // Sin esto, dos clicks rápidos mandan dos escrituras y la segunda deshace
    // la primera contra un estado que todavía no volvió.
    const w = mount(ToggleSwitch, { props: { modelValue: false, busy: true } })

    await w.trigger('click')

    expect(w.emitted('update:modelValue')).toBeUndefined()
  })

  it('deshabilitado no emite', async () => {
    const w = mount(ToggleSwitch, { props: { modelValue: true, disabled: true } })

    await w.trigger('click')

    expect(w.emitted('update:modelValue')).toBeUndefined()
  })

  it('el click no burbujea — la fila que lo contiene suele ser clickeable', async () => {
    // El interruptor vive dentro de una tarjeta que abre el detalle al
    // clickearla: sin `.stop`, prenderlo abría además el editor.
    const outer = { clicked: 0 }
    const w = mount(
      {
        components: { ToggleSwitch },
        template: '<div @click="outer.clicked++"><ToggleSwitch :model-value="false" /></div>',
        setup: () => ({ outer }),
      },
      { global: { components: { ToggleSwitch } } },
    )

    await w.find('button').trigger('click')

    expect(outer.clicked).toBe(0)
  })
})
