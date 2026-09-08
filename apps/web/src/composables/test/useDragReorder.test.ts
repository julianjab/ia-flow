import { afterEach, describe, expect, it, vi } from 'vitest'
import { useDragReorder } from '@/composables/useDragReorder'

// El gesto es Pointer Events y no la API de drag de HTML5, que es de mouse y en
// un teléfono no dispara nada. Acá se verifica la máquina de estados; el
// `elementFromPoint` se stubea porque jsdom no tiene layout.

function pointAt(el: Element | null) {
  document.elementFromPoint = vi.fn(() => el) as typeof document.elementFromPoint
}

function row(index: number): Element {
  const el = document.createElement('div')
  el.setAttribute('data-drag-index', String(index))
  return el
}

function press(button = 0) {
  return { button, cancelable: false, preventDefault() {} } as unknown as PointerEvent
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useDragReorder', () => {
  it('arrastrar de una fila a otra reordena', () => {
    const onReorder = vi.fn()
    const { start } = useDragReorder({ onReorder })
    start(0, press())
    pointAt(row(2))
    window.dispatchEvent(new Event('pointermove'))
    window.dispatchEvent(new Event('pointerup'))
    expect(onReorder).toHaveBeenCalledWith(0, 2)
  })

  it('soltar sobre la misma fila no reordena', () => {
    const onReorder = vi.fn()
    const { start } = useDragReorder({ onReorder })
    start(1, press())
    pointAt(row(1))
    window.dispatchEvent(new Event('pointermove'))
    window.dispatchEvent(new Event('pointerup'))
    expect(onReorder).not.toHaveBeenCalled()
  })

  it('soltar fuera de la lista no reordena', () => {
    // Sin fila debajo no hay destino: mover a "ningún lado" sería mover al
    // azar.
    const onReorder = vi.fn()
    const { start } = useDragReorder({ onReorder })
    start(0, press())
    pointAt(null)
    window.dispatchEvent(new Event('pointermove'))
    window.dispatchEvent(new Event('pointerup'))
    expect(onReorder).not.toHaveBeenCalled()
  })

  it('`pointercancel` NO reordena', () => {
    // Lo dispara el sistema cuando se lleva el gesto —una llamada entrante, el
    // swipe de volver de iOS—. Tratarlo como un `pointerup` movería la fila a
    // donde el dedo pasó de casualidad.
    const onReorder = vi.fn()
    const { start } = useDragReorder({ onReorder })
    start(0, press())
    pointAt(row(3))
    window.dispatchEvent(new Event('pointermove'))
    window.dispatchEvent(new Event('pointercancel'))
    expect(onReorder).not.toHaveBeenCalled()
  })

  it('el botón secundario no arranca el gesto', () => {
    // Un click derecho abre el menú contextual y dejaría el arrastre colgado.
    const onReorder = vi.fn()
    const { start, dragging } = useDragReorder({ onReorder })
    start(0, press(2))
    expect(dragging.value).toBeNull()
  })

  it('suelta los listeners al terminar — dos gestos seguidos no se pisan', () => {
    const onReorder = vi.fn()
    const { start } = useDragReorder({ onReorder })
    start(0, press())
    pointAt(row(1))
    window.dispatchEvent(new Event('pointermove'))
    window.dispatchEvent(new Event('pointerup'))
    expect(onReorder).toHaveBeenCalledTimes(1)

    // Sin el gesto vivo, un movimiento suelto no debería hacer nada.
    pointAt(row(4))
    window.dispatchEvent(new Event('pointermove'))
    window.dispatchEvent(new Event('pointerup'))
    expect(onReorder).toHaveBeenCalledTimes(1)
  })
})
