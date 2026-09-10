import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import StickyActionBar from '@/ui/StickyActionBar.vue'
import { useHasActionBar } from '../useActionBar'

// R4: tab bar o barra de acciones, nunca las dos. El shell lee esto para no
// dibujar la tab bar mientras hay un pie de formulario en pantalla.
describe('useActionBar', () => {
  const { hasActionBar } = useHasActionBar()

  it('es falso sin ninguna barra montada', () => {
    expect(hasActionBar.value).toBe(false)
  })

  it('se prende mientras la barra vive y se apaga al desmontarla', () => {
    const bar = mount(StickyActionBar)
    expect(hasActionBar.value).toBe(true)

    bar.unmount()
    expect(hasActionBar.value).toBe(false)
  })

  /**
   * Cuenta, no es un booleano: un formulario que se abre encima de una lista
   * que ya tenía su barra deja dos vivas: si la primera en desmontarse apagara
   * el flag, la tab bar volvería con la otra todavía en pantalla.
   */
  it('con dos barras, cerrar una no devuelve la tab bar', () => {
    const lista = mount(StickyActionBar)
    const formulario = mount(StickyActionBar)
    expect(hasActionBar.value).toBe(true)

    lista.unmount()
    expect(hasActionBar.value).toBe(true)

    formulario.unmount()
    expect(hasActionBar.value).toBe(false)
  })
})
