import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { useIsMobile, useIsSplit } from '@/composables/useIsMobile'

// Los dos breakpoints comparten maquinaria: un `matchMedia` por query, un solo
// listener para toda la app, liberado cuando se va el último consumidor.

const listeners = new Map<string, Set<(e: MediaQueryListEvent) => void>>()
const matches = new Map<string, boolean>()

function installMatchMedia() {
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return matches.get(query) ?? false
    },
    addEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => {
      if (!listeners.has(query)) listeners.set(query, new Set())
      listeners.get(query)?.add(cb)
    },
    removeEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => {
      listeners.get(query)?.delete(cb)
    },
  }))
}

function emit(query: string, value: boolean) {
  matches.set(query, value)
  for (const cb of listeners.get(query) ?? []) cb({ matches: value } as MediaQueryListEvent)
}

const MOBILE = '(max-width: 768px)'
const SPLIT = '(min-width: 1100px)'

afterEach(() => {
  listeners.clear()
  matches.clear()
  vi.unstubAllGlobals()
})

function host(use: () => unknown) {
  return defineComponent({
    setup() {
      const r = use() as Record<string, { value: boolean }>
      const key = Object.keys(r)[0]
      return () => h('i', String(r[key].value))
    },
  })
}

describe('useIsMobile / useIsSplit', () => {
  it('cada query tiene su propio ref — no se pisan entre sí', async () => {
    installMatchMedia()
    matches.set(MOBILE, true)
    matches.set(SPLIT, false)
    const m = mount(host(useIsMobile))
    const s = mount(host(useIsSplit))
    expect(m.text()).toBe('true')
    expect(s.text()).toBe('false')
    m.unmount()
    s.unmount()
  })

  it('reacciona al cruzar el breakpoint', async () => {
    installMatchMedia()
    const w = mount(host(useIsSplit))
    expect(w.text()).toBe('false')
    emit(SPLIT, true)
    await w.vm.$nextTick()
    expect(w.text()).toBe('true')
    w.unmount()
  })

  it('libera el listener cuando se va el último consumidor', () => {
    installMatchMedia()
    const a = mount(host(useIsMobile))
    const b = mount(host(useIsMobile))
    expect(listeners.get(MOBILE)?.size).toBe(1)
    a.unmount()
    expect(listeners.get(MOBILE)?.size).toBe(1)
    b.unmount()
    expect(listeners.get(MOBILE)?.size).toBe(0)
  })

  it('al re-suscribir re-sincroniza: sin listener el ref queda viejo', async () => {
    // Si la ventana cruzó el breakpoint mientras nadie escuchaba, el próximo
    // consumidor arrancaría montando el sidebar en un teléfono.
    installMatchMedia()
    const a = mount(host(useIsMobile))
    a.unmount()
    matches.set(MOBILE, true)
    const b = mount(host(useIsMobile))
    expect(b.text()).toBe('true')
    b.unmount()
  })
})
