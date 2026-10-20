import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SwipeRow from '@/ui/SwipeRow.vue'

const ACTIONS = [
  { id: 'act', label: 'Mergear', tone: 'primary' as const },
  { id: 'open', label: 'Detalle' },
]

function render(props: Record<string, unknown> = {}) {
  return mount(SwipeRow, {
    props: { actions: ACTIONS, ...props },
    slots: { default: '<button class="inner" type="button">fila</button>' },
    attachTo: document.body,
  })
}

/** Un dedo que arrastra `dx` px en horizontal sobre la cara de la fila. */
async function swipe(w: ReturnType<typeof render>, dx: number, type = 'touch') {
  const face = w.get('.sw__face')
  const at = (x: number) => ({
    pointerId: 1,
    pointerType: type,
    isPrimary: true,
    clientX: x,
    clientY: 100,
  })
  await face.trigger('pointerdown', at(300))
  for (let i = 1; i <= 5; i++) await face.trigger('pointermove', at(300 + (dx * i) / 5))
  await face.trigger('pointerup', at(300 + dx))
}

beforeEach(() => {
  // happy-dom no mide: las acciones miden 176 px.
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(176)
})
afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('SwipeRow', () => {
  it('cerrada, sus acciones no están en el orden de foco ni para el lector', () => {
    const w = render()
    expect(w.get('.sw__acts').attributes('aria-hidden')).toBe('true')
    expect(w.findAll('.sw__act').map((b) => b.attributes('tabindex'))).toEqual(['-1', '-1'])
    w.unmount()
  })

  it('deslizada más de la mitad a la izquierda queda abierta y sus acciones se pueden tocar', async () => {
    const w = render()
    await swipe(w, -120)
    expect(w.classes()).toContain('sw--open')
    expect(w.get('.sw__acts').attributes('aria-hidden')).toBe('false')
    await w.get('[data-test="swipe-act"]').trigger('click')
    expect(w.emitted('action')).toEqual([['act']])
    expect(w.classes()).not.toContain('sw--open')
    w.unmount()
  })

  it('menos de la mitad vuelve a su lugar', async () => {
    const w = render()
    await swipe(w, -60)
    expect(w.classes()).not.toContain('sw--open')
    w.unmount()
  })

  it('el mouse no arrastra: el gesto es del dedo', async () => {
    const w = render()
    await swipe(w, -150, 'mouse')
    expect(w.classes()).not.toContain('sw--open')
    w.unmount()
  })

  it('un arrastre vertical es scroll, no un deslizamiento', async () => {
    const w = render()
    const face = w.get('.sw__face')
    await face.trigger('pointerdown', {
      pointerId: 1,
      pointerType: 'touch',
      isPrimary: true,
      clientX: 300,
      clientY: 100,
    })
    await face.trigger('pointermove', {
      pointerId: 1,
      pointerType: 'touch',
      isPrimary: true,
      clientX: 290,
      clientY: 160,
    })
    await face.trigger('pointermove', {
      pointerId: 1,
      pointerType: 'touch',
      isPrimary: true,
      clientX: 150,
      clientY: 170,
    })
    await face.trigger('pointerup', {
      pointerId: 1,
      pointerType: 'touch',
      isPrimary: true,
      clientX: 150,
      clientY: 170,
    })
    expect(w.classes()).not.toContain('sw--open')
    w.unmount()
  })

  it('tocar una fila abierta la cierra en vez de hacer lo que haría el toque', async () => {
    const w = render()
    const inner = vi.fn()
    w.get('.inner').element.addEventListener('click', inner)
    await swipe(w, -150)
    await w.get('.inner').trigger('click')
    expect(inner).not.toHaveBeenCalled()
    expect(w.classes()).not.toContain('sw--open')
    w.unmount()
  })

  it('abrir una cierra la otra', async () => {
    const a = render()
    const b = render()
    await swipe(a, -150)
    await swipe(b, -150)
    expect(a.classes()).not.toContain('sw--open')
    expect(b.classes()).toContain('sw--open')
    a.unmount()
    b.unmount()
  })

  it('deshabilitada no se desliza', async () => {
    const w = render({ disabled: true })
    await swipe(w, -150)
    expect(w.find('.sw__acts').exists()).toBe(false)
    expect(w.classes()).not.toContain('sw--open')
    w.unmount()
  })
})
