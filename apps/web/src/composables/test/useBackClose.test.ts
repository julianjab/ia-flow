import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, type Ref, ref } from 'vue'

// El módulo guarda la pila de overlays: cada test arranca con uno nuevo.
let useBackClose: typeof import('../useBackClose').useBackClose
let historySettled: typeof import('../useBackClose').historySettled

let entries: unknown[] = []
const depth = () => (entries.at(-1) as { __overlay?: number } | null)?.__overlay ?? 0

/** El historial de mentira: `go` mueve la profundidad y avisa con su `popstate`, como un navegador. */
function fakeHistory() {
  entries = [null]
  vi.spyOn(window.history, 'pushState').mockImplementation((state: unknown) => {
    entries.push(state)
  })
  vi.spyOn(window.history, 'state', 'get').mockImplementation(() => entries.at(-1) ?? null)
  return vi.spyOn(window.history, 'go').mockImplementation((n = 0) => {
    entries = entries.slice(0, entries.length + n)
    queueMicrotask(() =>
      window.dispatchEvent(new PopStateEvent('popstate', { state: entries.at(-1) })),
    )
  })
}

function overlay(open: Ref<boolean>, enabled?: () => boolean) {
  return mount(
    defineComponent({
      setup() {
        useBackClose(
          () => open.value,
          () => (open.value = false),
          enabled,
        )
        return () => h('div')
      },
    }),
  )
}

/** El «atrás» del usuario. */
function pressBack() {
  entries.pop()
  window.dispatchEvent(new PopStateEvent('popstate', { state: entries.at(-1) ?? null }))
}

async function settle() {
  await flushPromises()
  await historySettled()
  await flushPromises()
}

beforeEach(async () => {
  vi.resetModules()
  ;({ useBackClose, historySettled } = await import('../useBackClose'))
})
afterEach(() => vi.restoreAllMocks())

describe('useBackClose', () => {
  it('abrir suma una entrada; el «atrás» la cierra sin salir de la pantalla', async () => {
    fakeHistory()
    const open = ref(false)
    const w = overlay(open)
    open.value = true
    await settle()
    expect(depth()).toBe(1)

    pressBack()
    await settle()
    expect(open.value).toBe(false)
    expect(depth()).toBe(0)
    w.unmount()
  })

  it('cerrar a mano consume su entrada: el siguiente «atrás» no cae en un overlay que ya no está', async () => {
    const go = fakeHistory()
    const open = ref(true)
    const w = overlay(open)
    await settle()
    open.value = false
    await settle()
    expect(go).toHaveBeenCalledWith(-1)
    expect(depth()).toBe(0)
    w.unmount()
  })

  it('el «atrás» cierra sólo el de arriba', async () => {
    fakeHistory()
    const below = ref(true)
    const above = ref(false)
    const a = overlay(below)
    await settle()
    const b = overlay(above)
    above.value = true
    await settle()
    expect(depth()).toBe(2)

    pressBack()
    await settle()
    expect(above.value).toBe(false)
    expect(below.value).toBe(true)
    a.unmount()
    b.unmount()
  })

  it('cerrar uno y abrir otro en el mismo toque deja una sola entrada, la del nuevo', async () => {
    const go = fakeHistory()
    const sheet = ref(true)
    const detail = ref(false)
    const a = overlay(sheet)
    const b = overlay(detail)
    await settle()
    sheet.value = false
    detail.value = true
    await settle()
    expect(go).toHaveBeenCalledWith(-1)
    expect(depth()).toBe(1)

    pressBack()
    await settle()
    expect(detail.value).toBe(false)
    expect(depth()).toBe(0)
    a.unmount()
    b.unmount()
  })

  it('cerrar dos a la vez vuelve de un solo salto', async () => {
    const go = fakeHistory()
    const below = ref(true)
    const above = ref(false)
    const a = overlay(below)
    await settle()
    const b = overlay(above)
    above.value = true
    await settle()
    below.value = false
    above.value = false
    await settle()
    expect(go).toHaveBeenCalledTimes(1)
    expect(go).toHaveBeenCalledWith(-2)
    expect(depth()).toBe(0)
    a.unmount()
    b.unmount()
  })

  it('apagado (`enabled` en false) no toca el historial', async () => {
    fakeHistory()
    const w = overlay(ref(true), () => false)
    await settle()
    expect(depth()).toBe(0)
    w.unmount()
  })
})
