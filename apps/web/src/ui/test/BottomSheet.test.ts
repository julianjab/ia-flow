import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import BottomSheet from '@/ui/BottomSheet.vue'

function render() {
  return mount(BottomSheet, {
    props: { open: true, title: 'El pipeline' },
    slots: { default: '<p class="content">contenido</p>' },
    attachTo: document.body,
  })
}

const $ = (sel: string) => document.body.querySelector(sel) as HTMLElement

function touch(target: Element, type: string, y: number | null, timeStamp: number) {
  const e = new Event(type, { bubbles: true, cancelable: true })
  Object.assign(e, { touches: y === null ? [] : [{ clientY: y }] })
  Object.defineProperty(e, 'timeStamp', { value: timeStamp })
  target.dispatchEvent(e)
}

/** Un dedo que arrastra `dy` px en vertical desde `from`, en `ms` milisegundos. */
async function drag(from: Element, dy: number, ms = 600) {
  touch(from, 'touchstart', 100, 0)
  for (let i = 1; i <= 5; i++) touch(from, 'touchmove', 100 + (dy * i) / 5, (ms * i) / 5)
  touch(from, 'touchend', null, ms)
  await flushPromises()
}

/** El ancho de la ventana: bajo 768px el sheet se arrastra; arriba es un diálogo centrado. */
function viewport(desktop: boolean) {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({ matches: desktop && query.includes('min-width'), media: query }) as MediaQueryList,
  )
}

beforeEach(() => viewport(false))
afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('BottomSheet: arrastrar para cerrar', () => {
  it('arrastrado hacia abajo desde el asa pasado un cuarto de su alto, se cierra', async () => {
    const w = render()
    vi.spyOn($('.bs'), 'getBoundingClientRect').mockReturnValue({ height: 400 } as DOMRect)
    await drag($('.bs__grab'), 200)
    // Termina de bajar (150 ms) y recién ahí avisa.
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(w.emitted('close')).toHaveLength(1)
    w.unmount()
  })

  it('un arrastre corto y lento vuelve a su lugar', async () => {
    const w = render()
    vi.spyOn($('.bs'), 'getBoundingClientRect').mockReturnValue({ height: 400 } as DOMRect)
    await drag($('.bs__head'), 40, 2000)
    expect(w.emitted('close')).toBeUndefined()
    expect($('.bs').style.transform).toBe('')
    w.unmount()
  })

  it('desde el cuerpo scrolleado no cierra: es el scroll de la lista', async () => {
    const w = render()
    $('.bs__body').scrollTop = 120
    await drag($('.content'), 300)
    expect(w.emitted('close')).toBeUndefined()
    w.unmount()
  })

  it('hacia arriba no es un cierre', async () => {
    const w = render()
    await drag($('.bs__grab'), -200)
    expect(w.emitted('close')).toBeUndefined()
    w.unmount()
  })

  it('en desktop es un diálogo centrado: no se arrastra', async () => {
    viewport(true)
    const w = render()
    vi.spyOn($('.bs'), 'getBoundingClientRect').mockReturnValue({ height: 400 } as DOMRect)
    await drag($('.bs__grab'), 300)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(w.emitted('close')).toBeUndefined()
    w.unmount()
  })
})
