import type { DOMWrapper, VueWrapper } from '@vue/test-utils'
import { flushPromises } from '@vue/test-utils'
import { vi } from 'vitest'

/**
 * Simular el gesto de reordenar en un entorno sin layout.
 *
 * El drag ya no es la API de HTML5 (que es de mouse y no existe en táctil) sino
 * Pointer Events: `pointerdown` sobre el handle, `pointermove` en `window`,
 * `pointerup`. El destino se resuelve con `document.elementFromPoint`, que en
 * jsdom **siempre devuelve null** porque no hay layout — así que se stubea para
 * que apunte a la fila destino.
 *
 * Es el precio de testear geometría sin geometría: el stub reemplaza al ojo del
 * navegador, no a la lógica.
 */
export async function dragTo(handle: DOMWrapper<Element>, target: Element) {
  const original = document.elementFromPoint
  document.elementFromPoint = vi.fn(() => target) as typeof document.elementFromPoint
  try {
    await handle.trigger('pointerdown', { button: 0 })
    window.dispatchEvent(new Event('pointermove'))
    window.dispatchEvent(new Event('pointerup'))
    await flushPromises()
  } finally {
    document.elementFromPoint = original
  }
}

/** El destino de un drag: la fila con ese índice. */
export function rowAt(wrapper: VueWrapper, index: number): Element {
  const row = wrapper.element.querySelector(`[data-drag-index="${index}"]`)
  if (!row) throw new Error(`No hay fila con data-drag-index="${index}"`)
  return row
}
