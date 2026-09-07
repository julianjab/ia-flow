import FollowTail from '@/ui/FollowTail.vue'
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { nextTick } from 'vue'

// El defecto que este componente existe para evitar: en una lista que crece por
// ARRIBA, cada entrada nueva empuja hacia abajo lo que estás leyendo, y con el
// socket activo el renglón se va de la pantalla mientras lo leés.

function scrollerOf(w: ReturnType<typeof mount>) {
  return w.get('.ft__scroller').element as HTMLElement
}

/**
 * jsdom no hace layout: `scrollTop` no se guarda si el elemento no es
 * scrolleable, y `scrollHeight` es siempre 0. Se simulan las dos.
 *
 * `scrollHeight` es una COLA: el componente lo lee dos veces por vuelta —antes
 * y después de que el DOM se actualice— y ese par ES lo que se está testeando.
 * Un valor fijo haría que "creció" nunca fuera cierto y el test pasaría sin
 * ejercitar la corrección.
 */
function fakeScroller(el: HTMLElement, heights: number[]) {
  let top = 0
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = v
    },
  })
  const queue = [...heights]
  let last = heights[0] ?? 0
  Object.defineProperty(el, 'scrollHeight', {
    configurable: true,
    get: () => {
      if (queue.length) last = queue.shift() as number
      return last
    },
  })
  el.scrollTo = ((opts: ScrollToOptions) => {
    top = opts.top ?? 0
  }) as HTMLElement['scrollTo']
}

describe('FollowTail', () => {
  it('en el tope no toca nada: seguir el stream es lo que se quiere ahí', async () => {
    const w = mount(FollowTail, { props: { count: 3 } })
    const el = scrollerOf(w)
    fakeScroller(el, [300, 360])
    await w.setProps({ count: 6 })
    await nextTick()
    expect(el.scrollTop).toBe(0)
    // Y no ofrece volver a un tope en el que ya estás.
    expect(w.find('[data-testid="follow-tail-pill"]').exists()).toBe(false)
  })

  it('scrolleado, corrige la posición por lo que creció arriba', async () => {
    const w = mount(FollowTail, { props: { count: 3 } })
    const el = scrollerOf(w)
    fakeScroller(el, [300, 360])
    el.scrollTop = 120
    await w.get('.ft__scroller').trigger('scroll')

    await w.setProps({ count: 5 })
    await nextTick()
    // 60px más arriba ⇒ 60px más de scroll: lo que mirabas queda donde estaba.
    expect(el.scrollTop).toBe(180)
  })

  it('cuenta lo que llegó mientras estabas leyendo', async () => {
    const w = mount(FollowTail, { props: { count: 3 } })
    const el = scrollerOf(w)
    fakeScroller(el, [300, 340, 340, 380])
    el.scrollTop = 120
    await w.get('.ft__scroller').trigger('scroll')

    // Dos vueltas: el watcher incrementa el contador DESPUÉS de su propio
    // `await nextTick()` (necesita el alto de después del render), así que el
    // DOM del pill se actualiza recién en la vuelta siguiente.
    await w.setProps({ count: 5 })
    await flushPromises()
    expect(w.get('[data-testid="follow-tail-pill"]').text()).toContain('2')

    await w.setProps({ count: 6 })
    await flushPromises()
    expect(w.get('[data-testid="follow-tail-pill"]').text()).toContain('3')
  })

  it('volver al tope limpia el contador — volver es un gesto tuyo', async () => {
    const w = mount(FollowTail, { props: { count: 3 } })
    const el = scrollerOf(w)
    fakeScroller(el, [300, 340])
    el.scrollTop = 120
    await w.get('.ft__scroller').trigger('scroll')
    await w.setProps({ count: 5 })
    await flushPromises()

    await w.get('[data-testid="follow-tail-pill"]').trigger('click')
    expect(el.scrollTop).toBe(0)
    expect(w.find('[data-testid="follow-tail-pill"]').exists()).toBe(false)
  })

  it('un scroll con inercia a 3px sigue contando como "en el tope"', async () => {
    // Sin el umbral, frenar el follow sería un bug que sólo pasa a veces.
    const w = mount(FollowTail, { props: { count: 3 } })
    const el = scrollerOf(w)
    fakeScroller(el, [300, 340])
    el.scrollTop = 3
    await w.get('.ft__scroller').trigger('scroll')
    await w.setProps({ count: 5 })
    await nextTick()
    expect(w.find('[data-testid="follow-tail-pill"]').exists()).toBe(false)
  })
})
